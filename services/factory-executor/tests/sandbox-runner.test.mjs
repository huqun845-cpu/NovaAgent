import { test } from "node:test";
import assert from "node:assert/strict";
import { VercelSandboxRepositoryRunner } from "../src/sandbox-runner.ts";

function fakeSandbox(scripts = { "type-check": "tsc", test: "node --test" }) {
  const calls = [];
  const sandbox = {
    runCommand: async (options) => {
      calls.push({ type: "command", options });
      if (options.cmd === "node") return { exitCode: 0, stdout: async () => JSON.stringify(scripts), stderr: async () => "" };
      return { exitCode: 0, stdout: async () => "ok\n", stderr: async () => "" };
    },
    updateNetworkPolicy: async policy => calls.push({ type: "policy", policy }),
    stop: async () => calls.push({ type: "stop" }),
  };
  return { sandbox, calls };
}
test("runs repository checks in an isolated sandbox and locks egress before scripts", async () => {
  const { sandbox, calls } = fakeSandbox();
  let createOptions;
  const runner = new VercelSandboxRepositoryRunner(async options => { createOptions = options; return sandbox; });
  const result = await runner.run({ repositoryFullName: "owner/project", commitSha: "a".repeat(40) });
  assert.equal(result.status, "passed");
  assert.equal(result.checks.filter(x => x.name !== "dependency-install" && x.status === "passed").length, 2);
  assert.equal(result.checks.find(x => x.name === "build").status, "skipped");
  assert.deepEqual(createOptions.networkPolicy, { allow: ["github.com", "codeload.github.com", "registry.npmjs.org"] });
  const denyIndex = calls.findIndex(x => x.type === "policy" && x.policy === "deny-all");
  const firstScriptIndex = calls.findIndex(x => x.type === "command" && x.options.args?.[0] === "run");
  assert.ok(denyIndex >= 0 && firstScriptIndex > denyIndex);
  assert.equal(calls.at(-1).type, "stop");
});
test("rejects arbitrary repository identifiers and non-immutable revisions", async () => {
  const runner = new VercelSandboxRepositoryRunner(async () => { throw new Error("must not create sandbox"); });
  await assert.rejects(() => runner.run({ repositoryFullName: "https://attacker.test/repo", commitSha: "a".repeat(40) }), /INVALID_REPOSITORY/);
  await assert.rejects(() => runner.run({ repositoryFullName: "owner/project", commitSha: "main" }), /INVALID_COMMIT_SHA/);
});
test("fails when no requested package scripts exist", async () => {
  const { sandbox, calls } = fakeSandbox({});
  const runner = new VercelSandboxRepositoryRunner(async () => sandbox);
  const result = await runner.run({ repositoryFullName: "owner/project", commitSha: "b".repeat(40), checks: ["test"] });
  assert.equal(result.status, "failed");
  assert.equal(result.checks[1].status, "skipped");
  assert.equal(calls.at(-1).type, "stop");
});
