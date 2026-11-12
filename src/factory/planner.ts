import { validateTaskGraph, topologicalOrder, type TaskDefinition } from "./domain";

export interface PlanInput {
  requirement: string;
  target: "web" | "api" | "desktop" | "mobile" | "fullstack";
  acceptanceCriteria: string[];
}

/**
 * Deterministic safe starter plan. LLM planning is added behind this contract
 * in Phase 2; model output must pass validateTaskGraph before persistence.
 */
export function createStarterPlan(input: PlanInput): TaskDefinition[] {
  if (!input.requirement.trim() || input.requirement.length > 20_000) throw new Error("INVALID_REQUIREMENT");
  if (!Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.length === 0) throw new Error("ACCEPTANCE_CRITERIA_REQUIRED");
  const tasks: TaskDefinition[] = [
    { id: "architecture", title: "Architecture and implementation plan", description: "Define components, boundaries, data model, risks and implementation sequence.", role: "architect", dependsOn: [], estimate: "medium" },
    { id: "backend", title: "Backend implementation", description: "Implement APIs, persistence and domain rules from the approved architecture.", role: "backend", dependsOn: ["architecture"], estimate: "large" },
    { id: "frontend", title: "Frontend implementation", description: "Implement user interface and client-side flows against the approved contracts.", role: "frontend", dependsOn: ["architecture"], estimate: "large" },
    { id: "integration", title: "Integration", description: "Integrate frontend and backend, handle errors and verify end-to-end contracts.", role: "integration", dependsOn: ["backend", "frontend"], estimate: "medium" },
    { id: "qa", title: "Automated quality assurance", description: "Run lint, type checks, unit, integration, E2E and build acceptance checks.", role: "qa", dependsOn: ["integration"], estimate: "medium" },
    { id: "security-review", title: "Independent security and code review", description: "Review authorization, secrets, dependency risk, data isolation and change quality.", role: "reviewer", dependsOn: ["qa"], estimate: "medium" },
  ];
  if (input.target === "api") tasks.splice(2, 1);
  validateTaskGraph(tasks);
  topologicalOrder(tasks);
  return tasks;
}