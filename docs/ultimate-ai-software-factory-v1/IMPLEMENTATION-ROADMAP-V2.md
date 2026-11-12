# V2 Implementation Roadmap and Acceptance Gates

## Delivery status (2026-11-13)
- [x] Phase 1A: isolated domain contracts, requirement validation, deterministic task DAG validation/planning, starter RBAC matrix, tenant-scope guard, run-state transition guard, PostgreSQL schema draft, run-creation application service, idempotency handling, and unit tests committed on `feat/ultimate-ai-software-factory-v1`.
- [x] Phase 1B foundation: isolated HTTP handler, HS256 JWT verification adapter, PostgREST repository, project/run endpoints, transactional RPC migration, authentication unit tests, and GitHub Actions validation workflow committed. Not yet mounted in the Worker or verified against a live PostgreSQL instance.
- [x] Phase 1B routing foundation: Factory API mounted on the Cloudflare Worker at `/api/factory/*` before Telegram/D1 request handling. Live PostgreSQL and OIDC/membership integration remain open.
- [x] Phase 2A: AI SDK 7 + AI Gateway requirement planner, authenticated plan endpoint, bounded fallback, untrusted-output DAG validation, and tests committed. Live Gateway call and CI pass not yet verified.
- [x] Phase 2B foundation: Postgres monthly input/output token budgets, atomic reservation/settlement RPCs, per-user invocation ledger, fail-closed budget checks, and adapter tests committed. Currency billing, real Gateway reconciliation, quotas UI, and evaluation suite remain open.
- [ ] Phase 2C: structured model evaluation, persisted plan versions/approval, provider-level price reconciliation, second-model independent review, and first Coding Harness adapter.
- [x] Phase 3A code foundation: separate Node.js Vercel Sandbox repository-check service, authenticated run/project resolution, immutable commit SHA, install-only egress allowlist then deny-all before scripts, fixed npm check allowlist, mocked tests, and separate deployment docs committed. Not deployed or live-tested; Worker dispatch and durable jobs remain open.
- [x] Phase 3B durable execution foundation: tenant-scoped enqueue/status APIs, PostgreSQL job ledger, idempotency keys, atomic `SKIP LOCKED` claims, expiring leases/reaping, bounded retries, per-organization concurrency and monthly execution-second reservations, audit/workflow events, and a Vercel Cron consumer. GitHub Actions now applies migrations 0001–0004 to PostgreSQL 16 and runs SQL acceptance tests for enqueue/idempotency, concurrency, retry exhaustion, lease recovery, budget accounting, and fail-closed missing budgets. Real Vercel Cron and Sandbox execution remain unverified.\n- [ ] Phase 3C: private-repository credential brokering, patch-capable coding harness, branch/PR workflow, artifact storage, and stronger global executor spend controls.
- [ ] Phases 4–7: durable parallel orchestration, repair/review gates, preview/production release and mobile delivery not yet implemented.


## Phase 0 — Baseline and non-regression
- Record current NovaAgent commit and deployment configuration.
- Run existing type-check, unit tests, and dry-run deploy.
- Add CI baseline and secret scanning.
- Acceptance: existing Telegram bot routes and Mini App remain unchanged.

## Phase 1 — Factory control plane
- Organization, membership, roles, project, repository binding.
- Requirement specification and acceptance criteria.
- Agent run, workflow, workflow event, task DAG, audit event.
- Authenticated factory API and dashboard shell.
- Acceptance: tenant isolation tests; authorization matrix; idempotency and pagination tests.

## Phase 2 — Model and harness gateway
- Implement typed provider and harness interfaces.
- Integrate AI SDK 7 behind an adapter.
- Add Vercel AI Gateway configuration and provider failover.
- Add harness adapters (start with one proven coding harness, then add a second independent reviewer).
- Acceptance: provider contract tests, timeout/cancellation tests, atomic monthly token-budget reservation/settlement, provider cost reconciliation, prompt redaction tests.

## Phase 3 — Sandboxed coding execution
- Create isolated sandbox per task attempt.
- Clone repository with short-lived token; create task branch.
- Apply patch, run commands, collect logs and artifacts.
- Restrict egress, block metadata/private IP ranges, set CPU/memory/time/disk limits.
- Acceptance: sandbox escape test plan, network-deny tests, credential non-persistence, workspace cleanup.



### Phase 3B implementation notes
- Apply migration `0004_durable_execution_jobs.sql` after migrations 0001–0003 on the dedicated Factory PostgreSQL database.
- Provision one `factory_execution_budgets` row per organization; missing budgets fail closed. The example provisioning SQL is in `services/factory-executor/README.md`.
- The Worker enqueues via `POST /api/factory/executions` using a required `Idempotency-Key`; the Vercel Cron consumer polls once per minute and claims at most one job per invocation.
- Current checks are read-only. The queue is at-least-once: a worker crash can cause a retry after lease expiry. The 240-second reservation is charged in full if a lease expires; completed jobs are charged by measured runtime capped at the reservation.
- The cron function has a 300-second maximum duration and claims a 300-second lease. Actual deployment plan limits and Cron availability must be checked before enabling production traffic.
\n## Phase 4 — Workflow and parallel engineering
- Durable workflow steps with checkpointing.
- Task dependency DAG and bounded parallelism.
- Retry with jitter, dead-letter handling, resume after deploy.
- Conflict detection and integration PR creation.
- Acceptance: crash/restart recovery, duplicate event handling, concurrent task isolation, budget enforcement.

## Phase 5 — QA and repair loop
- Deterministic lint/type/test/build gates.
- Browser E2E and acceptance tests.
- Dependency/license/secret scans.
- Bounded repair loop (maximum 3 attempts by default).
- Independent review agent.
- Acceptance: intentionally injected defects are detected; false success cannot bypass a gate.

## Phase 6 — Preview, approval, release
- Preview deploy adapter.
- Approval inbox with actor, commit SHA, environment, expiry and evidence.
- Production deployment only after approval.
- Health checks, rollback and release audit.
- Acceptance: reject expired/replayed approval; reject mismatched SHA; demonstrate rollback.

## Phase 7 — Product expansion
- Expo/EAS mobile build pipeline.
- Templates, reusable skills, design systems, project blueprints.
- Scheduled maintenance agents and dependency update PRs.
- Team/organization plans, quotas, usage reporting, billing integration.

## Required CI matrix

| Check | Pull request | Preview | Production |
|---|---:|---:|---:|
| Lint / format | Required | Required | Required |
| Type check | Required | Required | Required |
| Unit tests | Required | Required | Required |
| Integration tests | Required | Required | Required |
| E2E tests | Required for UI | Required | Required |
| Dependency / license scan | Required | Required | Required |
| Secret scan | Required | Required | Required |
| Build artifact | Required | Required | Required |
| Human approval | Not required | Policy-based | Required |
| Health check | N/A | Required | Required |
| Rollback evidence | N/A | N/A | Required |

## Operational SLO targets (initial proposal)

- Control-plane API availability: 99.9% monthly.
- Workflow event durability: no acknowledged event loss.
- Worker jobs: every job reaches success, terminal failure, or visible retry state.
- Recovery: resume from last durable checkpoint after worker restart.
- Audit: all privileged operations include actor, timestamp, project, action, target and result.
- Restore: quarterly restore drill with recorded RPO/RTO.

These are targets, not measured guarantees. Publish actual SLOs only after production telemetry validates them.
