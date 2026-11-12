import { test } from "node:test";
import assert from "node:assert/strict";
import { FactoryService } from "../src/factory/service.ts";

function fakeRepository(projectOrg = "org-1") {
  const runs = new Map();
  return {
    runs,
    async getProject(orgId, id) {
      return orgId === projectOrg ? { id, organizationId: projectOrg, name: "demo", repositoryFullName: null, defaultBranch: "main" } : null;
    },
    async findRunByIdempotency(orgId, key) { return runs.get(orgId + ":" + key) ?? null; },
    async createRunBundle(bundle) {
      const key = bundle.organizationId + ":" + bundle.idempotencyKey;
      if (runs.has(key)) throw new Error("UNIQUE_IDEMPOTENCY_CONFLICT");
      runs.set(key, bundle);
      return bundle;
    },
  };
}
const actor = { userId: "u-1", organizationId: "org-1", role: "admin" };
const input = {
  projectId: "p-1", idempotencyKey: "request-00000001", now: "2026-11-13T00:00:00.000Z",
  createId: () => "run-1",
  spec: { title: "Demo", description: "Build a portal", target: "fullstack", acceptanceCriteria: ["User can sign in"] },
};

test("FactoryService creates a tenant-scoped run and task DAG", async () => {
  const service = new FactoryService(fakeRepository());
  const result = await service.createRun(actor, input);
  assert.equal(result.reused, false);
  assert.equal(result.run.status, "queued");
  assert.equal(result.run.tasks.find(t => t.id === "architecture").status, "ready");
  assert.equal(result.run.tasks.find(t => t.id === "backend").status, "blocked");
});
test("FactoryService returns the existing run for an idempotent retry", async () => {
  const service = new FactoryService(fakeRepository());
  const first = await service.createRun(actor, input);
  const second = await service.createRun(actor, input);
  assert.equal(second.reused, true);
  assert.equal(second.run.id, first.run.id);
});
test("FactoryService rejects reuse of an idempotency key for another project", async () => {
  const service = new FactoryService(fakeRepository());
  await service.createRun(actor, input);
  await assert.rejects(() => service.createRun(actor, { ...input, projectId: "p-2" }), /IDEMPOTENCY_KEY_REUSED/);
});
test("FactoryService enforces role and organization scope", async () => {
  const service = new FactoryService(fakeRepository());
  await assert.rejects(() => service.createRun({ ...actor, role: "viewer" }, input), /FORBIDDEN/);
  await assert.rejects(() => service.createRun({ ...actor, organizationId: "org-2" }, input), /PROJECT_NOT_FOUND/);
});
