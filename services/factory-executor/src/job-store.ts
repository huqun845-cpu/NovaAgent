import type { CheckName, RepositoryCheckRequest, RepositoryCheckResult } from "./sandbox-runner.ts";

export interface ClaimedExecutionJob {
  id: string;
  organizationId: string;
  projectId: string;
  runId: string;
  repositoryFullName: string;
  commitSha: string;
  checks: CheckName[];
  attempt: number;
  maxAttempts: number;
  workerId: string;
  timeoutMs: number;
}
export interface ExecutionJobStore {
  claim(workerId: string): Promise<ClaimedExecutionJob | null>;
  finish(input: {
    jobId: string;
    workerId: string;
    status: "succeeded" | "failed";
    result: RepositoryCheckResult | null;
    error?: string;
    runtimeSeconds: number;
  }): Promise<unknown>;
}
export interface ExecutionRunner {
  run(input: RepositoryCheckRequest): Promise<RepositoryCheckResult>;
}

export async function runNextExecutionJob(
  store: ExecutionJobStore,
  runner: ExecutionRunner,
  workerId: string,
  clock: () => number = Date.now,
): Promise<{ status: "idle" } | { status: "finished"; jobId: string; outcome: "succeeded" | "failed"; retrying: boolean }> {
  const job = await store.claim(workerId);
  if (!job) return { status: "idle" };
  const started = clock();
  let result: RepositoryCheckResult | null = null;
  let failure: string | undefined;
  try {
    result = await runner.run({
      repositoryFullName: job.repositoryFullName,
      commitSha: job.commitSha,
      checks: job.checks,
      timeoutMs: job.timeoutMs,
    });
    if (result.status === "failed") failure = "One or more repository checks failed";
  } catch (cause) {
    failure = (cause instanceof Error ? cause.message : "EXECUTION_FAILED").slice(0, 4000);
  }
  const runtimeSeconds = Math.max(0, Math.ceil((clock() - started) / 1000));
  const outcome = result?.status === "passed" ? "succeeded" : "failed";
  // Persist exactly once. A DB write failure must escape so the lease can
  // expire and be recovered; it must not be rewritten as a second failure.
  const saved = await store.finish({
    jobId: job.id,
    workerId,
    status: outcome,
    result,
    error: failure,
    runtimeSeconds,
  }) as { status?: string } | null;
  return {
    status: "finished",
    jobId: job.id,
    outcome,
    retrying: saved?.status === "queued",
  };
}

export class PostgrestExecutionJobStore implements ExecutionJobStore {
  private readonly base: string;
  constructor(
    private readonly config: { url: string; serviceKey: string },
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.base = config.url.replace(/\/$/, "");
    if (!/^https:\/\//.test(this.base) || !config.serviceKey) throw new Error("INVALID_DATABASE_CONFIGURATION");
  }
  private async rpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.fetcher(this.base + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: {
        apikey: this.config.serviceKey,
        authorization: "Bearer " + this.config.serviceKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("DATABASE_RPC_FAILED:" + response.status);
    return await response.json() as T;
  }
  async claim(workerId: string): Promise<ClaimedExecutionJob | null> {
    return this.rpc<ClaimedExecutionJob | null>("factory_claim_execution_job", {
      p_worker_id: workerId,
      p_lease_seconds: 300,
      p_reservation_seconds: 240,
    });
  }
  async finish(input: {
    jobId: string; workerId: string; status: "succeeded" | "failed";
    result: RepositoryCheckResult | null; error?: string; runtimeSeconds: number;
  }): Promise<unknown> {
    return this.rpc("factory_finish_execution_job", {
      p_job_id: input.jobId,
      p_worker_id: input.workerId,
      p_status: input.status,
      p_result: input.result,
      p_error: input.error ?? null,
      p_runtime_seconds: input.runtimeSeconds,
    });
  }
}
