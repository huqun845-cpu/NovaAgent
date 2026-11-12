import { authenticateBearer } from "../../../src/factory/auth.ts";
import { PostgrestFactoryRepository } from "../../../src/factory/postgrest-repository.ts";
import { VercelSandboxRepositoryRunner } from "../src/sandbox-runner.ts";

interface RequestLike {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): void;
}
interface ExecutorEnv {
  FACTORY_AUTH_SECRET?: string;
  FACTORY_AUTH_ISSUER?: string;
  FACTORY_AUTH_AUDIENCE?: string;
  FACTORY_DATABASE_REST_URL?: string;
  FACTORY_DATABASE_SERVICE_KEY?: string;
}
function error(res: ResponseLike, status: number, code: string): void {
  res.status(status).json({ error: code });
}
export default async function handler(req: RequestLike, res: ResponseLike): Promise<void> {
  if (req.method !== "POST") return error(res, 405, "METHOD_NOT_ALLOWED");
  const env = process.env as ExecutorEnv;
  if (!env.FACTORY_AUTH_SECRET || !env.FACTORY_AUTH_ISSUER || !env.FACTORY_AUTH_AUDIENCE ||
      !env.FACTORY_DATABASE_REST_URL || !env.FACTORY_DATABASE_SERVICE_KEY) return error(res, 503, "EXECUTOR_NOT_CONFIGURED");
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }
    const requestBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    if (new TextEncoder().encode(requestBody).byteLength > 4096) return error(res, 413, "REQUEST_TOO_LARGE");
    const request = new Request("https://factory-executor.invalid" + (req.url ?? "/api/execute"), {
      method: "POST", headers, body: requestBody,
    });
    const actor = await authenticateBearer(request, {
      secret: env.FACTORY_AUTH_SECRET, issuer: env.FACTORY_AUTH_ISSUER, audience: env.FACTORY_AUTH_AUDIENCE,
    });
    if (!["owner", "admin", "architect", "engineer", "qa"].includes(actor.role)) return error(res, 403, "FORBIDDEN");
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 4096) return error(res, 413, "REQUEST_TOO_LARGE");
    const body = JSON.parse(raw) as Record<string, unknown>;
    const runId = typeof body.runId === "string" ? body.runId : "";
    const commitSha = typeof body.commitSha === "string" ? body.commitSha : "";
    if (!/^[0-9a-f-]{36}$/i.test(runId) || !/^[a-f0-9]{40}$/i.test(commitSha)) return error(res, 400, "INVALID_EXECUTION_INPUT");
    const repository = new PostgrestFactoryRepository({
      url: env.FACTORY_DATABASE_REST_URL, serviceKey: env.FACTORY_DATABASE_SERVICE_KEY,
    });
    const run = await repository.getRun(actor.organizationId, runId);
    if (!run) return error(res, 404, "RUN_NOT_FOUND");
    if (!["queued", "running", "qa"].includes(run.status)) return error(res, 409, "RUN_NOT_EXECUTABLE");
    const project = await repository.getProject(actor.organizationId, run.projectId);
    if (!project?.repositoryFullName) return error(res, 409, "PROJECT_REPOSITORY_NOT_CONFIGURED");
    const checks = Array.isArray(body.checks) ? body.checks : undefined;
    const result = await new VercelSandboxRepositoryRunner().run({
      repositoryFullName: project.repositoryFullName,
      commitSha,
      checks: checks as ("type-check" | "test" | "build" | "lint")[] | undefined,
      timeoutMs: 180_000,
    });
    res.status(result.status === "passed" ? 200 : 422).json({ result });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "INTERNAL_ERROR";
    const status = message === "UNAUTHENTICATED" || message.startsWith("INVALID_TOKEN") || message === "TOKEN_EXPIRED" ? 401 :
      message.startsWith("INVALID_") ? 400 : 502;
    error(res, status, status === 502 ? "EXECUTION_FAILED" : message);
  }
}
