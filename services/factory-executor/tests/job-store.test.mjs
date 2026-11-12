import test from "node:test";
import assert from "node:assert/strict";
import { runNextExecutionJob } from "../src/job-store.ts";

const job = {
  id: "job-1",
  organizationId: "org-1",
  projectId: "project-1",
  runId: "run-1",
  repositoryFullName: "acme/app",
  commitSha: "a".repeat(40),
  checks: ["type-check", "test"],
  attempt: 1,
  maxAttempts: 3,
  workerId: "worker-1",
  timeoutMs: 180000,
};

test("idle worker does not start a sandbox", async () => {
  let started = false;
  const result = await runNextExecutionJob(
    { claim: async () => null, finish: async () => assert.fail("finish must not run") },
    { run: async () => { started = true; throw new Error("unexpected"); } },
    "worker-1",
  );
  assert.deepEqual(result, { status: "idle" });
  assert.equal(started, false);
});

test("claimed job executes immutable repository inputs and persists success", async () => {
  const finished = [];
  const runnerCalls = [];
  let tick = 1000;
  const result = await runNextExecutionJob(
    {
      claim: async workerId => ({ ...job, workerId }),
      finish: async input => { finished.push(input); return { status: "succeeded" }; },
    },
    { run: async input => {
      runnerCalls.push(input);
      return {
        sandboxId: "sandbox-1", repositoryFullName: input.repositoryFullName, commitSha: input.commitSha,
        status: "passed", checks: [{ name: "test", status: "passed", exitCode: 0, stdout: "ok", stderr: "" }],
        startedAt: new Date(1000).toISOString(), finishedAt: new Date(2000).toISOString(),
      };
    } },
    "worker-1",
    () => { tick += 1000; return tick; },
  );
  assert.deepEqual(runnerCalls, [{
    repositoryFullName: "acme/app", commitSha: "a".repeat(40),
    checks: ["type-check", "test"], timeoutMs: 180000,
  }]);
  assert.equal(finished[0].jobId, "job-1");
  assert.equal(finished[0].status, "succeeded");
  assert.equal(finished[0].runtimeSeconds, 1);
  assert.deepEqual(result, { status: "finished", jobId: "job-1", outcome: "succeeded", retrying: false });
});

test("failed checks are persisted as failed and respect database retry decision", async () => {
  const finished = [];
  const result = await runNextExecutionJob(
    {
      claim: async () => job,
      finish: async input => { finished.push(input); return { status: "queued" }; },
    },
    { run: async input => ({
      sandboxId: "sandbox-2", repositoryFullName: input.repositoryFullName, commitSha: input.commitSha,
      status: "failed", checks: [{ name: "test", status: "failed", exitCode: 1, stdout: "", stderr: "assertion" }],
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    }) },
    "worker-1",
  );
  assert.equal(finished[0].status, "failed");
  assert.match(finished[0].error, /checks failed/);
  assert.equal(result.retrying, true);
});

test("runner exceptions are persisted for bounded retry", async () => {
  const finished = [];
  const result = await runNextExecutionJob(
    {
      claim: async () => job,
      finish: async input => { finished.push(input); return { status: "failed" }; },
    },
    { run: async () => { throw new Error("sandbox unavailable"); } },
    "worker-1",
  );
  assert.equal(finished[0].status, "failed");
  assert.equal(finished[0].result, null);
  assert.equal(finished[0].error, "sandbox unavailable");
  assert.equal(result.retrying, false);
});
