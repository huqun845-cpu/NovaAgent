# V2 Implementation Roadmap and Acceptance Gates

## Delivery status (2026-11-13)
- [x] Phase 1A: isolated domain contracts, requirement validation, deterministic task DAG validation/planning, starter RBAC matrix, tenant-scope guard, run-state transition guard, PostgreSQL schema draft, run-creation application service, idempotency handling, and unit tests committed on `feat/ultimate-ai-software-factory-v1`.
- [ ] Phase 1B: authenticated API, identity provider integration, PostgreSQL repository, dashboard shell, audit write path, and integration tests.
- [ ] Phases 2–7: not started. No model execution, coding sandbox, durable worker, CI execution, preview deployment, or production release is claimed as implemented.


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
- Acceptance: provider contract tests, timeout/cancellation tests, usage/cost recording, prompt redaction tests.

## Phase 3 — Sandboxed coding execution
- Create isolated sandbox per task attempt.
- Clone repository with short-lived token; create task branch.
- Apply patch, run commands, collect logs and artifacts.
- Restrict egress, block metadata/private IP ranges, set CPU/memory/time/disk limits.
- Acceptance: sandbox escape test plan, network-deny tests, credential non-persistence, workspace cleanup.

## Phase 4 — Workflow and parallel engineering
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
