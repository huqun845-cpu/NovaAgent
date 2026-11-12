# Phase 3B — Durable Sandbox Execution

## Goal

Move repository checks out of the synchronous Cloudflare Worker request path. The Worker authenticates and records an execution request in PostgreSQL; a separate Node.js Vercel Cron function claims and runs one job inside an ephemeral Vercel Sandbox.

This is a durable CI/check execution slice. It is not yet the autonomous code-writing harness.

## Components

- Cloudflare Worker: `POST /api/factory/executions` and `GET /api/factory/executions/{jobId}`.
- PostgreSQL: `factory_execution_jobs`, `factory_execution_budgets`, and atomic RPC functions.
- Vercel Node function: `GET /api/worker`, scheduled every minute.
- Sandbox adapter: immutable commit checkout, install-only egress allowlist, then deny-all network before running fixed npm scripts.

## API

### Enqueue

`POST /api/factory/executions`

Requires a Factory JWT with run-create, task-execute, or QA-execute capability, plus:
- `Idempotency-Key` header (8–160 characters).
- `runId` (UUID).
- `commitSha` (full 40-character hex SHA).
- Optional `checks`: unique subset of `type-check`, `test`, `build`, `lint`.

The repository URL is not accepted from the caller. The database resolves it from the run's tenant-scoped project. Reusing the same idempotency key with identical inputs returns the existing job; different inputs produce a conflict.

### Status

`GET /api/factory/executions/{jobId}`

Requires run-read capability. The query filters by both authenticated organization ID and job ID. It returns status, attempts, timestamps, error summary, immutable commit SHA, requested checks, and bounded check logs.

## Job lifecycle

```text
queued
  -> running (atomic claim + lease + budget reservation)
  -> succeeded
  -> queued (retryable failure; bounded backoff)
  -> failed (max attempts reached)
```

- Default maximum attempts: 3.
- Claim lease: 300 seconds.
- Sandbox timeout: 180 seconds.
- Execution reservation: 240 seconds.
- Expired leases are reaped on the next claim. The reservation is charged conservatively, and the job is requeued with backoff or marked failed after the attempt limit.
- Delivery is at-least-once. Current operations are read-only checks, so duplicate execution has no source-control side effects.

## Organization budgets

Each organization needs a row in `factory_execution_budgets`. Missing budget rows are excluded from claims (fail closed).

- `monthly_limit_seconds`: maximum monthly Sandbox execution seconds.
- `monthly_used_seconds`: settled execution seconds.
- `reserved_seconds`: in-flight reservations.
- `active_count` / `max_concurrent`: per-organization concurrency control.

The claim RPC locks the job and budget rows, checks quota, and reserves 240 seconds before returning a job. A completed run settles measured runtime capped by the reservation. A lease-expired job consumes its full reservation. Monthly used seconds roll over when the next month's claim cycle begins.

Budget units are execution seconds, not currency. Provider charges, Vercel plan quotas, and global cross-organization concurrency still need separate reconciliation and limits.

## Database functions

Migration `0004_durable_execution_jobs.sql` creates:
- `factory_enqueue_execution_job`
- `factory_reap_expired_execution_jobs`
- `factory_claim_execution_job`
- `factory_finish_execution_job`

The RPCs are revoked from PUBLIC and granted only to `service_role`. The application service credential remains server-side. The enqueue API enforces user JWT, role and tenant scope before calling the RPC.

## Vercel configuration

Project Root Directory: `services/factory-executor`.

Required server environment:
- `FACTORY_DATABASE_REST_URL`
- `FACTORY_DATABASE_SERVICE_KEY`
- `CRON_SECRET`

The `vercel.json` cron schedule is `* * * * *`; the function checks the standard `Authorization: Bearer <CRON_SECRET>` header. Confirm the selected Vercel plan supports the configured schedule and 300-second function duration before enabling the production consumer.

## Automated acceptance

GitHub Actions runs two gates:
1. Node 22 type-check, unit tests, executor tests and Cloudflare Worker dry-run.
2. A PostgreSQL 16 service that applies migrations 0001–0004 and executes `tests/sql/factory-execution-jobs.sql`.

The SQL acceptance script verifies:
- job enqueue and idempotent replay, including replay after the parent run becomes terminal;
- one-active-job concurrency enforcement;
- bounded retry and terminal failure;
- expired-lease reaping, conservative budget charge and reclaim;
- active/reserved/used counter settlement;
- no claim when an organization has no budget row.

## Not yet verified in production

A green GitHub Actions run proves code-level and PostgreSQL 16 migration/SQL acceptance only. It does not prove a live Supabase/PostgREST configuration, Vercel deployment, Cron invocation, Vercel OIDC identity, actual Sandbox clone/install, network firewall behavior, or cleanup. Those remain deployment acceptance gates.

## Next phase

Phase 3C adds private repository checkout through a credential broker, a patch-capable Coding Harness, per-task worktrees/branches, diff validation, GitHub App PR creation, and independent reviewer execution. No raw GitHub write token may enter the sandbox.
