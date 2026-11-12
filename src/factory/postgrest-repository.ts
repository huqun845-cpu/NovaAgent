import type { FactoryRepository, FactoryProjectRecord, CreateRunBundle, FactoryRunRecord } from "./service";
import type { TaskNode } from "./domain";

export interface PostgrestConfig { url: string; serviceKey: string; }
interface DbProject {
  id: string; organization_id: string; name: string;
  repository_full_name: string | null; default_branch: string;
}
interface DbTask {
  task_key: string; title: string; description: string; role: TaskNode["role"];
  status: TaskNode["status"]; attempt: number; depends_on?: string[];
}
interface DbRun {
  id: string; organization_id: string; project_id: string; created_by: string;
  idempotency_key: string; status: FactoryRunRecord["status"];
  created_at: string; spec: FactoryRunRecord["spec"]; tasks: DbTask[];
}
export interface FactoryProjectInput { name: string; repositoryFullName?: string | null; defaultBranch?: string; }

export class PostgrestFactoryRepository implements FactoryRepository {
  private readonly base: string;
  constructor(private readonly config: PostgrestConfig, private readonly fetcher: typeof fetch = fetch) {
    this.base = config.url.replace(/\/$/, "");
    if (!/^https:\/\//.test(this.base) || !config.serviceKey) throw new Error("INVALID_DATABASE_CONFIGURATION");
  }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(this.base + path, {
      ...init,
      headers: {
        apikey: this.config.serviceKey,
        authorization: "Bearer " + this.config.serviceKey,
        "content-type": "application/json",
        accept: "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      throw new Error("DATABASE_REQUEST_FAILED:" + response.status + ":" + body);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
  async listProjects(organizationId: string): Promise<FactoryProjectRecord[]> {
    const query = new URLSearchParams({ select: "id,organization_id,name,repository_full_name,default_branch", organization_id: "eq." + organizationId, order: "updated_at.desc", limit: "100" });
    const rows = await this.request<DbProject[]>("/rest/v1/factory_projects?" + query.toString());
    return rows.map(row => this.project(row));
  }
  async createProject(organizationId: string, actorId: string, input: FactoryProjectInput): Promise<FactoryProjectRecord> {
    const rows = await this.request<DbProject[]>("/rest/v1/rpc/factory_create_project", {
      method: "POST", body: JSON.stringify({
        p_organization_id: organizationId, p_actor_id: actorId,
        p_name: input.name, p_repository_full_name: input.repositoryFullName ?? null,
        p_default_branch: input.defaultBranch ?? "main",
      }),
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw new Error("PROJECT_CREATE_FAILED");
    return this.project(row as DbProject);
  }
  async getProject(organizationId: string, projectId: string): Promise<FactoryProjectRecord | null> {
    const query = new URLSearchParams({ select: "id,organization_id,name,repository_full_name,default_branch", id: "eq." + projectId, organization_id: "eq." + organizationId, limit: "1" });
    const rows = await this.request<DbProject[]>("/rest/v1/factory_projects?" + query.toString());
    return rows[0] ? this.project(rows[0]) : null;
  }
  async findRunByIdempotency(organizationId: string, key: string): Promise<FactoryRunRecord | null> {
    const rows = await this.request<DbRun[]>("/rest/v1/rpc/factory_get_run_by_idempotency", {
      method: "POST", body: JSON.stringify({ p_organization_id: organizationId, p_idempotency_key: key }),
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    return row ? this.run(row as DbRun) : null;
  }
  async createRunBundle(bundle: CreateRunBundle): Promise<FactoryRunRecord> {
    const rows = await this.request<DbRun[]>("/rest/v1/rpc/factory_create_run_bundle", {
      method: "POST", body: JSON.stringify({
        p_id: bundle.id, p_organization_id: bundle.organizationId, p_project_id: bundle.projectId,
        p_created_by: bundle.createdBy, p_idempotency_key: bundle.idempotencyKey,
        p_spec: bundle.spec, p_tasks: bundle.tasks, p_created_at: bundle.createdAt,
      }),
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw new Error("RUN_CREATE_FAILED");
    return this.run(row as DbRun);
  }
  async getRun(organizationId: string, runId: string): Promise<FactoryRunRecord | null> {
    const row = await this.request<DbRun | null>("/rest/v1/rpc/factory_get_run", {
      method: "POST", body: JSON.stringify({ p_organization_id: organizationId, p_run_id: runId }),
    });
    return row ? this.run(row) : null;
  }
  private project(row: DbProject): FactoryProjectRecord {
    return { id: row.id, organizationId: row.organization_id, name: row.name, repositoryFullName: row.repository_full_name, defaultBranch: row.default_branch };
  }
  private run(row: DbRun): FactoryRunRecord {
    return {
      id: row.id, organizationId: row.organization_id, projectId: row.project_id, createdBy: row.created_by,
      idempotencyKey: row.idempotency_key, status: row.status, spec: row.spec,
      tasks: (row.tasks ?? []).map(task => ({
        id: task.task_key, title: task.title, description: task.description, role: task.role,
        status: task.status, attempt: task.attempt, dependsOn: task.depends_on ?? [],
      })),
      createdAt: row.created_at,
    };
  }
}
