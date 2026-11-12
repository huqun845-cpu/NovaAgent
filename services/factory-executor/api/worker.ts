import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { PostgrestExecutionJobStore, runNextExecutionJob } from "../src/job-store.ts";
import { VercelSandboxRepositoryRunner } from "../src/sandbox-runner.ts";

interface RequestLike {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}
interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): void;
}
interface WorkerEnv {
  FACTORY_DATABASE_REST_URL?: string;
  FACTORY_DATABASE_SERVICE_KEY?: string;
  FACTORY_EXECUTOR_CRON_SECRET?: string;
}
function header(req: RequestLike, name: string): string {
  const value = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
function safeSecretEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}
function reply(res: ResponseLike, status: number, body: unknown): void {
  res.status(status).json(body);
}

/** Vercel Cron consumer: claims at most one durable job per invocation. */
export default async function handler(req: RequestLike, res: ResponseLike): Promise<void> {
  if (req.method !== "GET" && req.method !== "POST") return reply(res, 405, { error: "METHOD_NOT_ALLOWED" });
  const env = process.env as WorkerEnv;
  if (!env.FACTORY_DATABASE_REST_URL || !env.FACTORY_DATABASE_SERVICE_KEY || !env.FACTORY_EXECUTOR_CRON_SECRET) {
    return reply(res, 503, { error: "EXECUTOR_WORKER_NOT_CONFIGURED" });
  }
  const authorization = header(req, "authorization");
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!safeSecretEqual(env.FACTORY_EXECUTOR_CRON_SECRET, supplied)) return reply(res, 401, { error: "UNAUTHENTICATED" });

  const workerId = "vercel:" + (process.env.VERCEL_REGION ?? "region-unknown") + ":" + randomUUID();
  try {
    const store = new PostgrestExecutionJobStore({
      url: env.FACTORY_DATABASE_REST_URL,
      serviceKey: env.FACTORY_DATABASE_SERVICE_KEY,
    });
    const result = await runNextExecutionJob(store, new VercelSandboxRepositoryRunner(), workerId);
    return reply(res, 200, result);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "WORKER_FAILED";
    // Do not return database details, tokens, or sandbox internals to the cron caller.
    return reply(res, 502, { error: "EXECUTOR_WORKER_FAILED", detail: message.slice(0, 160) });
  }
}
