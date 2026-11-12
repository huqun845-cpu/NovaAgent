import test from "node:test";
import assert from "node:assert/strict";
import { PostgrestFactoryRepository } from "../src/factory/postgrest-repository.ts";

test("execution enqueue RPC persists tenant, immutable SHA, checks and idempotency key", async () => {
  let request;
  const repository = new PostgrestFactoryRepository(
    { url: "https://db.example", serviceKey: "server-only" },
    async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({
        id: "job-1", runId: "run-1", status: "queued", attempts: 0, createdAt: "2026-11-13T00:00:00Z",
      }), { status: 200 });
    },
  );
  const job = await repository.enqueueExecutionJob({
    organizationId: "org-1", runId: "run-1", actorId: "user-1",
    commitSha: "a".repeat(40), idempotencyKey: "test-key-001",
    checks: ["type-check", "test"],
  });
  assert.equal(job.id, "job-1");
  assert.match(request.url, /rpc\/factory_enqueue_execution_job$/);
  assert.equal(request.init.headers.authorization, "Bearer server-only");
  assert.deepEqual(JSON.parse(request.init.body), {
    p_organization_id: "org-1", p_run_id: "run-1", p_actor_id: "user-1",
    p_commit_sha: "a".repeat(40), p_idempotency_key: "test-key-001",
    p_checks: ["type-check", "test"],
  });
});
