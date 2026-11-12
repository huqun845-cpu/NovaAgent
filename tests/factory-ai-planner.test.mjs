import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTaskPlan } from "../src/factory/ai-planner.ts";

test("accepts a valid task DAG and normalizes optional estimates", () => {
  const tasks = parseTaskPlan(JSON.stringify({ tasks: [
    { id: "design", title: "Design", description: "Define architecture", role: "architect", dependsOn: [], estimate: "medium" },
    { id: "build", title: "Build", description: "Implement the feature", role: "backend", dependsOn: ["design"] },
  ] }));
  assert.equal(tasks.length, 2);
  assert.equal(tasks[1].dependsOn[0], "design");
});
test("rejects unknown roles and unknown dependencies", () => {
  assert.throws(() => parseTaskPlan(JSON.stringify([{ id: "a", title: "A", description: "A task", role: "root", dependsOn: [] }])), /INVALID_AI_PLAN_TASK/);
  assert.throws(() => parseTaskPlan(JSON.stringify([{ id: "a", title: "A", description: "A task", role: "backend", dependsOn: ["missing"] }])), /UNKNOWN_TASK_DEPENDENCY/);
});
test("rejects cyclic, duplicate and oversized task graphs", () => {
  assert.throws(() => parseTaskPlan(JSON.stringify([
    { id: "a", title: "A", description: "A task", role: "backend", dependsOn: ["b"] },
    { id: "b", title: "B", description: "B task", role: "qa", dependsOn: ["a"] },
  ])), /TASK_GRAPH_CYCLE/);
  assert.throws(() => parseTaskPlan(JSON.stringify([
    { id: "a", title: "A", description: "A task", role: "backend", dependsOn: [] },
    { id: "a", title: "A2", description: "A task 2", role: "qa", dependsOn: [] },
  ])), /DUPLICATE_TASK_ID/);
  assert.throws(() => parseTaskPlan(JSON.stringify({ tasks: [] })), /INVALID_AI_PLAN_SIZE/);
});
test("rejects non-JSON model output", () => {
  assert.throws(() => parseTaskPlan("Here is your plan: not-json"), SyntaxError);
});
