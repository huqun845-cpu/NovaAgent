import { authenticateBearer, type FactoryAuthConfig } from "./auth";
import { canPerform } from "./domain";
import { FactoryService } from "./service";
import { PostgrestFactoryRepository, type PostgrestConfig } from "./postgrest-repository";
import { handleFactoryPlanningRequest } from "./planning-http";

export interface FactoryHttpEnv {
  FACTORY_AUTH_SECRET: string;
  FACTORY_AUTH_ISSUER: string;
  FACTORY_AUTH_AUDIENCE: string;
  FACTORY_DATABASE_REST_URL: string;
  FACTORY_DATABASE_SERVICE_KEY: string;
  FACTORY_PLANNER_MODEL: string;
  FACTORY_PLANNER_FALLBACK_MODEL?: string;
  AI_GATEWAY_API_KEY: string;
}
const MAX_BODY_BYTES = 64 * 1024;
async function readJson(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new Error("REQUEST_TOO_LARGE");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new Error("REQUEST_TOO_LARGE");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("INVALID_JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_JSON");
  return parsed as Record<string, unknown>;
}
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
});
const errors: Record<string, number> = {
  UNAUTHENTICATED: 401, INVALID_TOKEN: 401, INVALID_TOKEN_ALGORITHM: 401, INVALID_TOKEN_SIGNATURE: 401,
  INVALID_TOKEN_CLAIMS: 401, TOKEN_EXPIRED: 401, TOKEN_NOT_ACTIVE: 401, INVALID_TOKEN_IDENTITY: 401,
  INVALID_TOKEN_ROLE: 401, FORBIDDEN: 403, PROJECT_NOT_FOUND: 404, TENANT_SCOPE_DENIED: 404,
  INVALID_SPEC: 400, INVALID_SPEC_TITLE: 400, INVALID_SPEC_DESCRIPTION: 400, INVALID_SPEC_TARGET: 400,
  INVALID_ACCEPTANCE_CRITERIA: 400, INVALID_CONSTRAINTS: 400, INVALID_PROJECT_ID: 400, INVALID_IDEMPOTENCY_KEY: 400,
  IDEMPOTENCY_KEY_REUSED: 409, INVALID_JSON: 400, INVALID_PROJECT_INPUT: 400, REQUEST_TOO_LARGE: 413,\n  INVALID_EXECUTION_INPUT: 400, INVALID_CHECK_SET: 400, RUN_NOT_FOUND: 404, RUN_NOT_EXECUTABLE: 409,\n  PROJECT_REPOSITORY_NOT_CONFIGURED: 409, EXECUTION_ENQUEUE_FAILED: 500,
};

export async function handleFactoryRequest(request: Request, env: FactoryHttpEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/factory/health" && request.method === "GET") return json({ ok: true, service: "factory-control-plane" });
  if (!url.pathname.startsWith("/api/factory/")) return json({ error: "NOT_FOUND" }, 404);
  try {
    const actor = await authenticateBearer(request, {
      secret: env.FACTORY_AUTH_SECRET, issuer: env.FACTORY_AUTH_ISSUER, audience: env.FACTORY_AUTH_AUDIENCE,
    } satisfies FactoryAuthConfig);
    if (url.pathname === "/api/factory/plan" && request.method === "POST") {
      if (!canPerform(actor.role, "run:create")) return json({ error: "FORBIDDEN" }, 403);
      return handleFactoryPlanningRequest(request, env, actor);
    }
    const repository = new PostgrestFactoryRepository({
      url: env.FACTORY_DATABASE_REST_URL, serviceKey: env.FACTORY_DATABASE_SERVICE_KEY,
    } satisfies PostgrestConfig);
    const service = new FactoryService(repository);

    if (url.pathname === "/api/factory/projects" && request.method === "GET") {
      if (!canPerform(actor.role, "project:read")) return json({ error: "FORBIDDEN" }, 403);
      return json({ projects: await repository.listProjects(actor.organizationId) });
    }
    if (url.pathname === "/api/factory/projects" && request.method === "POST") {
      if (!canPerform(actor.role, "project:manage")) return json({ error: "FORBIDDEN" }, 403);
      const body = await readJson(request);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const repo = body.repositoryFullName;
      const defaultBranch = typeof body.defaultBranch === "string" ? body.defaultBranch : "main";
      if (!name || name.length > 160 || (repo !== undefined && repo !== null && (typeof repo !== "string" || repo.length > 255)) || !/^[A-Za-z0-9._/-]{1,255}$/.test(defaultBranch)) {
        return json({ error: "INVALID_PROJECT_INPUT" }, 400);
      }
      return json({ project: await repository.createProject(actor.organizationId, actor.userId, { name, repositoryFullName: repo as string | null, defaultBranch }) }, 201);
    }
    if (url.pathname === "/api/factory/executions" && request.method === "POST") {
      if (!canPerform(actor.role, "run:create") && !canPerform(actor.role, "task:execute") && !canPerform(actor.role, "qa:execute")) {
        return json({ error: "FORBIDDEN" }, 403);
      }
      const body = await readJson(request);
      const runId = typeof body.runId === "string" ? body.runId : "";
      const commitSha = typeof body.commitSha === "string" ? body.commitSha : "";
      const idempotencyKey = request.headers.get("idempotency-key") ?? "";
      if (!/^[0-9a-f-]{36}$/i.test(runId) || !/^[a-f0-9]{40}$/i.test(commitSha) ||
          idempotencyKey.length < 8 || idempotencyKey.length > 160) {
        return json({ error: "INVALID_EXECUTION_INPUT" }, 400);
      }
      const allowed = new Set(["type-check", "test", "build", "lint"]);
      const checks = body.checks === undefined ? ["type-check", "test", "build"] :
        Array.isArray(body.checks) ? body.checks : [];
      if (checks.length < 1 || checks.length > 4 ||
          checks.some((name: unknown) => typeof name !== "string" || !allowed.has(name)) ||
          new Set(checks).size !== checks.length) {
        return json({ error: "INVALID_CHECK_SET" }, 400);
      }
      const job = await repository.enqueueExecutionJob({
        organizationId: actor.organizationId,
        runId,
        actorId: actor.userId,
        commitSha: commitSha.toLowerCase(),
        idempotencyKey,
        checks: checks as ("type-check" | "test" | "build" | "lint")[],
      });
      return json({ job }, job.attempts > 0 || job.status !== "queued" ? 200 : 202);
    }
    if (url.pathname === "/api/factory/runs" && request.method === "POST") {
      const idempotencyKey = request.headers.get("idempotency-key") ?? "";
      const body = await readJson(request);
      const result = await service.createRun(actor, { projectId: String(body.projectId ?? ""), spec: body.spec, idempotencyKey });
      return json(result, result.reused ? 200 : 201);
    }
    const runMatch = /^\/api\/factory\/runs\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (runMatch && request.method === "GET") {
      if (!canPerform(actor.role, "run:read")) return json({ error: "FORBIDDEN" }, 403);
      const run = await repository.getRun(actor.organizationId, runMatch[1]);
      return run ? json({ run }) : json({ error: "NOT_FOUND" }, 404);
    }
    return json({ error: "NOT_FOUND" }, 404);
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":")[0] : "INTERNAL_ERROR";
    const status = errors[code] ?? (code === "AUTH_NOT_CONFIGURED" ? 503 : 500);
    return json({ error: status === 500 ? "INTERNAL_ERROR" : code }, status);
  }
}
