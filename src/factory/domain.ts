/**
 * Software Factory domain primitives.
 * Intentionally independent from Telegram, Cloudflare bindings and model SDKs.
 */
export const FACTORY_ROLES = ["owner", "admin", "architect", "engineer", "qa", "reviewer", "viewer"] as const;
export type FactoryRole = typeof FACTORY_ROLES[number];
export type RunStatus = "queued" | "planning" | "running" | "qa" | "awaiting_approval" | "succeeded" | "failed" | "cancelled";
export type TaskStatus = "blocked" | "ready" | "running" | "succeeded" | "failed" | "cancelled";

export interface RequirementSpec {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  constraints?: string[];
  target: "web" | "api" | "desktop" | "mobile" | "fullstack";
}
export interface TaskDefinition {
  id: string;
  title: string;
  description: string;
  role: "architect" | "frontend" | "backend" | "integration" | "qa" | "security" | "reviewer" | "release";
  dependsOn: string[];
  estimate?: "small" | "medium" | "large";
}
export interface TaskNode extends TaskDefinition {
  status: TaskStatus;
  attempt: number;
}
export interface FactoryRun {
  id: string;
  organizationId: string;
  projectId: string;
  createdBy: string;
  status: RunStatus;
  spec: RequirementSpec;
  tasks: TaskNode[];
  createdAt: string;
  updatedAt: string;
}
export interface AuditEvent {
  id: string;
  organizationId: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome: "success" | "denied" | "failure";
  metadata: Record<string, unknown>;
  createdAt: string;
}

const MAX_TITLE = 160;
const MAX_DESCRIPTION = 20_000;
const MAX_CRITERIA = 80;
const MAX_TASKS = 100;

export function validateRequirementSpec(input: unknown): RequirementSpec {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_SPEC");
  const value = input as Record<string, unknown>;
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : "";
  const target = value.target;
  const acceptanceCriteria = value.acceptanceCriteria;
  if (!title || title.length > MAX_TITLE) throw new Error("INVALID_SPEC_TITLE");
  if (!description || description.length > MAX_DESCRIPTION) throw new Error("INVALID_SPEC_DESCRIPTION");
  if (!["web", "api", "desktop", "mobile", "fullstack"].includes(String(target))) throw new Error("INVALID_SPEC_TARGET");
  if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length < 1 || acceptanceCriteria.length > MAX_CRITERIA) {
    throw new Error("INVALID_ACCEPTANCE_CRITERIA");
  }
  const criteria = acceptanceCriteria.map(item => typeof item === "string" ? item.trim() : "");
  if (criteria.some(item => !item || item.length > 1000)) throw new Error("INVALID_ACCEPTANCE_CRITERIA");
  const constraints = value.constraints === undefined ? [] : value.constraints;
  if (!Array.isArray(constraints) || constraints.length > 80 || constraints.some(x => typeof x !== "string" || x.length > 1000)) {
    throw new Error("INVALID_CONSTRAINTS");
  }
  return { title, description, target: target as RequirementSpec["target"], acceptanceCriteria: criteria, constraints: constraints as string[] };
}

export function validateTaskGraph(tasks: TaskDefinition[]): TaskDefinition[] {
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > MAX_TASKS) throw new Error("INVALID_TASK_GRAPH_SIZE");
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task || typeof task.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(task.id)) throw new Error("INVALID_TASK_ID");
    if (ids.has(task.id)) throw new Error("DUPLICATE_TASK_ID");
    ids.add(task.id);
    if (!task.title?.trim() || task.title.length > MAX_TITLE) throw new Error("INVALID_TASK_TITLE");
    if (!task.description?.trim() || task.description.length > MAX_DESCRIPTION) throw new Error("INVALID_TASK_DESCRIPTION");
    if (!Array.isArray(task.dependsOn) || task.dependsOn.some(dep => typeof dep !== "string")) throw new Error("INVALID_TASK_DEPENDENCIES");
  }
  for (const task of tasks) {
    if (new Set(task.dependsOn).size !== task.dependsOn.length) throw new Error("DUPLICATE_TASK_DEPENDENCY");
    if (task.dependsOn.includes(task.id)) throw new Error("TASK_SELF_DEPENDENCY");
    if (task.dependsOn.some(dep => !ids.has(dep))) throw new Error("UNKNOWN_TASK_DEPENDENCY");
  }
  topologicalOrder(tasks);
  return tasks;
}

/** Kahn topological sort. Throws on cycles and returns deterministic task order. */
export function topologicalOrder(tasks: TaskDefinition[]): string[] {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const indegree = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  const children = new Map<string, string[]>();
  for (const task of tasks) for (const dep of task.dependsOn) {
    const list = children.get(dep) ?? [];
    list.push(task.id);
    children.set(dep, list);
  }
  const ready = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
  const result: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    result.push(id);
    for (const child of (children.get(id) ?? []).sort()) {
      const next = indegree.get(child)! - 1;
      indegree.set(child, next);
      if (next === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }
  if (result.length !== byId.size) throw new Error("TASK_GRAPH_CYCLE");
  return result;
}

export function getRunnableTasks(tasks: TaskNode[]): TaskNode[] {
  const succeeded = new Set(tasks.filter(task => task.status === "succeeded").map(task => task.id));
  return tasks.filter(task => task.status === "blocked" || task.status === "ready")
    .filter(task => task.dependsOn.every(dep => succeeded.has(dep)))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(task => ({ ...task, status: "ready" }));
}

const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ["planning", "cancelled", "failed"],
  planning: ["running", "failed", "cancelled"],
  running: ["qa", "failed", "cancelled"],
  qa: ["running", "awaiting_approval", "succeeded", "failed", "cancelled"],
  awaiting_approval: ["succeeded", "failed", "cancelled"],
  succeeded: [], failed: [], cancelled: [],
};
export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!RUN_TRANSITIONS[from].includes(to)) throw new Error("INVALID_RUN_TRANSITION");
}

export function canPerform(role: FactoryRole, action: string): boolean {
  const permissions: Record<FactoryRole, string[]> = {
    owner: ["*"],
    admin: ["org:manage", "member:manage", "project:manage", "run:create", "run:cancel", "release:approve", "audit:read"],
    architect: ["project:read", "project:manage", "run:create", "run:read", "task:read"],
    engineer: ["project:read", "run:read", "task:read", "task:execute"],
    qa: ["project:read", "run:read", "task:read", "qa:execute"],
    reviewer: ["project:read", "run:read", "task:read", "review:submit"],
    viewer: ["project:read", "run:read", "task:read"],
  };
  return permissions[role].includes("*") || permissions[role].includes(action);
}

export function assertTenantScope(expectedOrganizationId: string, resourceOrganizationId: string): void {
  if (!expectedOrganizationId || expectedOrganizationId !== resourceOrganizationId) throw new Error("TENANT_SCOPE_DENIED");
}
