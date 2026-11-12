# Ultimate AI Software Factory V1.0 — Architecture

## 1. System topology

```text
Browser / Admin UI
       |
       v
Cloudflare API Gateway + Auth
       |
       +------ Projects / Specs / Approvals API
       |
       v
Durable Workflow Orchestrator
       |
       +------ D1 metadata + audit events
       +------ Queues (plan / code / test / deploy)
       +------ R2 artifacts and logs
       |
       v
Ephemeral Execution Coordinator
       |
       +------ isolated build sandbox A
       +------ isolated browser-test sandbox B
       +------ isolated security-scan sandbox C
       |
       v
GitHub App ----> feature branch ----> PR ----> review / merge
       |
       v
Preview deploy ----> evidence ----> human approval ----> production deploy
```

The Worker control plane handles trusted API and orchestration logic only. It must never evaluate or execute untrusted generated source code.

## 2. Trust boundaries

1. **Browser to API:** session authentication, CSRF protection where cookie sessions are used, origin validation, schema validation, rate limits.
2. **API to provider:** provider-specific credentials stay server-side; redact secrets from prompts and logs; enforce per-project budgets.
3. **Orchestrator to executor:** signed, short-lived job claims; strict job schemas; tenant/project scope; bounded runtime, CPU, memory, disk, and output size.
4. **Executor to network:** deny by default; allowlist package registries and explicitly approved endpoints; block cloud metadata IP ranges and private network ranges.
5. **GitHub webhook to API:** verify HMAC signature over raw body, timestamp/replay controls, event deduplication.
6. **Preview to public internet:** isolated preview origin, no production secrets, safe headers, expiry and teardown policy.
7. **Release approval to deploy:** require authenticated actor, role, environment, commit SHA, quality evidence, and one-time approval token.

## 3. Core domain entities

- Organization, Membership, Role
- Project, RepositoryBinding, Environment
- RequirementSpec, AcceptanceCriterion
- AgentRun, AgentMessage, ProviderInvocation
- Workflow, WorkflowStep, WorkflowEvent
- Job, JobAttempt, WorkerLease
- Artifact, TestRun, QualityGate
- PullRequest, Deployment, DeploymentEvent
- Approval, AuditEvent, UsageRecord, SecretReference

All tenant-owned records carry `organization_id`. Authorization is enforced in service methods, not only UI visibility.

## 4. API surface (initial contract)

- `POST /api/factory/projects`
- `GET /api/factory/projects/:projectId`
- `POST /api/factory/projects/:projectId/specifications`
- `POST /api/factory/projects/:projectId/runs`
- `GET /api/factory/runs/:runId`
- `GET /api/factory/runs/:runId/events`
- `POST /api/factory/runs/:runId/cancel`
- `POST /api/factory/runs/:runId/plan-approval`
- `POST /api/factory/deployments/:deploymentId/approval`
- `POST /api/factory/webhooks/github`

All mutating endpoints require idempotency keys. Pagination is cursor-based. API responses use a stable error envelope with request ID and machine-readable code.

## 5. Provider contract

Each provider adapter implements:
- `plan(input, context)`
- `generate(input, context)`
- `review(diff, context)`
- `repair(failures, context)`

Adapters return typed structured outputs, usage metadata, provider request IDs, and retry classification. The planner validates output against JSON schemas. No provider output is trusted as executable policy.

## 6. Quality gates

Required baseline before preview:
- dependency install from lockfile;
- formatter and linter;
- type check;
- unit tests;
- integration tests;
- production build;
- dependency vulnerability audit;
- secret scanning;
- license policy check;
- generated diff review for protected paths.

Project-specific acceptance tests are added from the specification. E2E browser tests are recommended for user-facing apps.

## 7. Release policy

- Agent may create feature branches and pull requests.
- Agent may deploy preview environments after all mandatory gates pass.
- Agent may not merge to protected production branch without authorized approval.
- Agent may not deploy production without a separate release approval.
- Rollback must reference a known-good deployment and record the initiating actor and reason.

## 8. Reliability

- Durable workflow checkpoints after each meaningful phase.
- Idempotent queue consumers and webhook handlers.
- Exponential retry with jitter for transient provider/network errors.
- Dead-letter queue and operator-visible failure reason.
- Bounded repair loops (default maximum 3 attempts per gate).
- Per-project concurrency and budget limits.
- Periodic backup export and tested restore procedure.

## 9. Open implementation decisions

Before production:
- select the isolated execution provider (container service or microVM platform);
- select identity/session strategy and organization model;
- confirm GitHub App installation permissions;
- choose Vercel vs Cloudflare Pages as default deploy target;
- select durable workflow implementation;
- confirm data residency, retention, and backup RPO/RTO.
