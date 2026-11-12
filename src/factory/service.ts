import {
  assertTenantScope, canPerform, validateRequirementSpec,
  type FactoryRole, type RequirementSpec, type TaskNode,
} from "./domain";
import { createStarterPlan } from "./planner";

export interface FactoryActor {
  userId: string;
  organizationId: string;
  role: FactoryRole;
}
export interface FactoryProjectRecord {
  id: string;
  organizationId: string;
  name: string;
  repositoryFullName: string | null;
  defaultBranch: string;
}
export interface CreateRunBundle {
  id: string;
  organizationId: string;
  projectId: string;
  createdBy: string;
  idempotencyKey: string;
  status: "queued";
  spec: RequirementSpec;
  tasks: TaskNode[];
  createdAt: string;
}
export interface FactoryRunRecord extends CreateRunBundle {}
/**
 * Persistence port. Implementations must write the run, immutable spec,
 * tasks/dependencies and audit event in one database transaction.
 */
export interface FactoryRepository {
  getProject(organizationId: string, projectId: string): Promise<FactoryProjectRecord | null>;
  findRunByIdempotency(organizationId: string, idempotencyKey: string): Promise<FactoryRunRecord | null>;
  createRunBundle(bundle: CreateRunBundle): Promise<FactoryRunRecord>;
}
export interface CreateRunInput {
  projectId: string;
  spec: unknown;
  idempotencyKey: string;
  now?: string;
  createId?: () => string;
}

/** Application service; authentication is supplied by the future HTTP adapter. */
export class FactoryService {
  constructor(private readonly repository: FactoryRepository) {}

  async createRun(actor: FactoryActor, input: CreateRunInput): Promise<{ run: FactoryRunRecord; reused: boolean }> {
    if (!actor.userId || !actor.organizationId) throw new Error("UNAUTHENTICATED");
    if (!canPerform(actor.role, "run:create")) throw new Error("FORBIDDEN");
    if (!input.projectId || input.projectId.length > 100) throw new Error("INVALID_PROJECT_ID");
    if (!/^[a-zA-Z0-9._:-]{8,160}$/.test(input.idempotencyKey)) throw new Error("INVALID_IDEMPOTENCY_KEY");

    const existing = await this.repository.findRunByIdempotency(actor.organizationId, input.idempotencyKey);
    if (existing) {
      assertTenantScope(actor.organizationId, existing.organizationId);
      if (existing.projectId !== input.projectId) throw new Error("IDEMPOTENCY_KEY_REUSED");
      return { run: existing, reused: true };
    }

    const project = await this.repository.getProject(actor.organizationId, input.projectId);
    if (!project) throw new Error("PROJECT_NOT_FOUND");
    assertTenantScope(actor.organizationId, project.organizationId);

    const spec = validateRequirementSpec(input.spec);
    const definitions = createStarterPlan({
      requirement: spec.description,
      target: spec.target,
      acceptanceCriteria: spec.acceptanceCriteria,
    });
    const now = input.now ?? new Date().toISOString();
    const tasks: TaskNode[] = definitions.map(task => ({
      ...task,
      status: task.dependsOn.length === 0 ? "ready" : "blocked",
      attempt: 0,
    }));
    const bundle: CreateRunBundle = {
      id: (input.createId ?? (() => crypto.randomUUID()))(),
      organizationId: actor.organizationId,
      projectId: project.id,
      createdBy: actor.userId,
      idempotencyKey: input.idempotencyKey,
      status: "queued",
      spec,
      tasks,
      createdAt: now,
    };
    const run = await this.repository.createRunBundle(bundle);
    assertTenantScope(actor.organizationId, run.organizationId);
    return { run, reused: false };
  }
}
