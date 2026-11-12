import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateRequirementSpec, validateTaskGraph, topologicalOrder,
  getRunnableTasks, assertRunTransition, canPerform, assertTenantScope,
} from "../src/factory/domain.ts";
import { createStarterPlan } from "../src/factory/planner.ts";

const graph = [
  { id: "a", title: "A", description: "first", role: "architect", dependsOn: [] },
  { id: "b", title: "B", description: "second", role: "backend", dependsOn: ["a"] },
  { id: "c", title: "C", description: "third", role: "qa", dependsOn: ["b"] },
];

test("validates and normalizes a requirement spec", () => {
  const spec = validateRequirementSpec({ title: " Demo ", description: " Build it ", target: "web", acceptanceCriteria: [" works "] });
  assert.equal(spec.title, "Demo");
  assert.deepEqual(spec.acceptanceCriteria, ["works"]);
});
test("rejects empty or malformed acceptance criteria", () => {
  assert.throws(() => validateRequirementSpec({ title: "x", description: "y", target: "web", acceptanceCriteria: [] }), /INVALID_ACCEPTANCE_CRITERIA/);
});
test("validates task graph and produces deterministic topological order", () => {
  assert.deepEqual(topologicalOrder(validateTaskGraph(graph)), ["a", "b", "c"]);
});
test("rejects duplicate IDs, unknown dependencies and cycles", () => {
  assert.throws(() => validateTaskGraph([graph[0], graph[0]]), /DUPLICATE_TASK_ID/);
  assert.throws(() => validateTaskGraph([{ ...graph[0], dependsOn: ["missing"] }]), /UNKNOWN_TASK_DEPENDENCY/);
  assert.throws(() => validateTaskGraph([{ ...graph[0], dependsOn: ["a"] }]), /TASK_SELF_DEPENDENCY/);
  assert.throws(() => validateTaskGraph([
    { ...graph[0], dependsOn: ["b"] }, { ...graph[1], dependsOn: ["a"] },
  ]), /TASK_GRAPH_CYCLE/);
});
test("only tasks whose dependencies succeeded become runnable", () => {
  const nodes = graph.map((task, i) => ({ ...task, status: i === 0 ? "succeeded" : "blocked", attempt: 0 }));
  assert.deepEqual(getRunnableTasks(nodes).map(task => task.id), ["b"]);
});
test("run transitions are explicit and terminal states cannot reopen", () => {
  assertRunTransition("queued", "planning");
  assert.throws(() => assertRunTransition("succeeded", "running"), /INVALID_RUN_TRANSITION/);
});
test("role permissions deny production approval to engineers and viewers", () => {
  assert.equal(canPerform("admin", "release:approve"), true);
  assert.equal(canPerform("engineer", "release:approve"), false);
  assert.equal(canPerform("viewer", "task:execute"), false);
});
test("tenant boundary rejects cross-organization resource access", () => {
  assertTenantScope("org-a", "org-a");
  assert.throws(() => assertTenantScope("org-a", "org-b"), /TENANT_SCOPE_DENIED/);
});
test("starter plan is a valid DAG and has QA plus independent review gates", () => {
  const plan = createStarterPlan({ requirement: "Build a portal", target: "fullstack", acceptanceCriteria: ["user can sign in"] });
  const ids = new Set(plan.map(task => task.id));
  assert.ok(ids.has("qa"));
  assert.ok(ids.has("security-review"));
  assert.deepEqual(topologicalOrder(plan).slice(0, 1), ["architecture"]);
});
