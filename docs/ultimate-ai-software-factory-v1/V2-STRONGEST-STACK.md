# Ultimate AI Software Factory — V2 Frontier Stack

Status: architecture decision proposal for implementation. This document upgrades the V1 blueprint; it is not a claim that the runtime has already been migrated or deployed.

## Product direction

Build a cloud-native software engineering control plane that can orchestrate multiple established coding harnesses rather than reimplement every coding capability inside one chatbot.

The platform owns:
- product specification and acceptance criteria;
- project memory and architecture context;
- task graph, dependency scheduling, and parallel workspaces;
- harness/model routing and budget policies;
- sandbox lifecycle and resource policy;
- CI evidence, security gates, approvals, deployment, and rollback;
- audit, observability, and tenant governance.

Coding harnesses are replaceable execution engines. The factory is the orchestrator and quality authority.

## Recommended stack

| Layer | Default | Why |
|---|---|---|
| Agent framework | Vercel eve | Durable agent sessions, tools, skills, subagents, schedules, evals |
| Agent SDK | Vercel AI SDK 7 | Provider-agnostic agents, tool approvals, WorkflowAgent, harness integration |
| Model gateway | Vercel AI Gateway | Unified routing, provider fallback, per-agent model selection |
| Coding harnesses | OpenHands + Claude Code/Codex/Pi adapters | Use proven engineering harnesses; swap by task type |
| Execution sandbox | Vercel Sandbox / microVM-backed sandbox adapter | Run untrusted code and package installs outside control plane |
| Durable workflow | eve / AI SDK WorkflowAgent; adapter boundary for Temporal | Resume across deploys, retries, human approval waits |
| Control plane | Vercel-hosted Next.js app + API | Admin console, project workspace, approval inbox |
| Database | Managed PostgreSQL (Neon or Supabase) | Relational project graph, tenancy, audit and queryability |
| Queue | Managed durable queue / workflow runtime | Backpressure, retries, dead-letter handling |
| Artifact storage | S3-compatible object storage (R2 or Vercel Drives where suitable) | Build outputs, logs, test evidence, snapshots |
| Source control | GitHub App | Least-privilege repository access, branches, PRs, checks |
| Web delivery | Vercel | Preview deployments, production releases, rollback |
| Mobile delivery | Expo + EAS adapter | Build and distribute iOS/Android apps |
| Telemetry | OpenTelemetry + Sentry / managed logs | Trace model calls, tools, workflow spans and sandbox jobs |

Cloudflare remains valuable for DNS, WAF, edge routing, R2, Queues, and lightweight edge services. It should not be the only execution environment for arbitrary builds and browser automation.

## Multi-agent organization

1. **Chief Architect** — turns the request into a system design, risks, and architecture decisions.
2. **Product Analyst** — user stories, edge cases, acceptance criteria, and scope.
3. **Planner** — dependency DAG, milestones, parallelizable work, and resource estimate.
4. **Frontend Engineer** — UI implementation and accessibility.
5. **Backend Engineer** — API, domain services, data and migrations.
6. **Integration Engineer** — third-party APIs, auth, webhooks, and contracts.
7. **QA Engineer** — tests, browser automation, regression and acceptance.
8. **Security Engineer** — threat modeling, dependency and secret scans, permission review.
9. **Code Reviewer** — independent diff review, maintainability and regression review.
10. **Release Engineer** — preview, approvals, deployment, health checks and rollback.

Each role has its own instruction set, tools, context budget, and policy. The Planner can delegate, but the Security Engineer and Release Engineer have veto gates.

## Routing policy

Route by task characteristics, not by a fixed brand preference:
- architecture and ambiguous product reasoning → strongest reasoning model;
- broad codebase exploration → long-context model;
- implementation → coding harness selected for repository/language;
- independent review → different provider/harness from implementation;
- simple transformations and metadata → low-cost fast model;
- security review → specialized scanners plus independent reasoning review.

Every model invocation records provider, model, input/output token usage, latency, retry count, and estimated cost. Never send secrets to model context.

## Parallel execution model

- One task = one isolated workspace and branch.
- Parallel tasks must not modify the same files unless the planner establishes explicit ownership.
- Integrate through PRs or patch sets; never let concurrent agents push to the same working tree.
- Each worker receives a short-lived, repository-scoped token.
- The coordinator validates task output against acceptance criteria before merge.
- A maximum concurrency and budget policy applies per organization and project.

## Mandatory quality gates

A generated project is only "release candidate" when:
1. clean dependency install from lockfile;
2. formatting and lint;
3. type check / static analysis;
4. unit tests;
5. integration tests with isolated test services;
6. browser E2E for user-facing flows;
7. production build;
8. dependency, license, secret, and container scans;
9. migration forward/rollback checks;
10. independent code review;
11. all project acceptance criteria have evidence.

Security-critical findings block release. A model's assertion that tests passed is not evidence; the factory must collect machine-generated results.

## Release policy

- Agents may create branches and PRs.
- Agents may run preview deployments when policy gates pass.
- Production deployment always requires a named human approver, exact commit SHA, environment, test evidence, and a time-limited approval.
- Post-deploy health checks run automatically.
- Failed health checks can trigger automatic rollback to the previous known-good deployment if configured.
- All actions are auditable.

## Migration from NovaAgent

1. Preserve the current Nova bot and Workers entry points.
2. Add the factory as an isolated product boundary under `src/factory/`.
3. Add adapters around current Gemini/tool functionality; do not couple the factory domain to Telegram chat state.
4. Create a separate factory dashboard and authenticated API.
5. Introduce PostgreSQL for factory multi-tenant data; retain D1 for existing Nova data until a deliberate migration is approved.
6. Add GitHub App integration and signed webhooks.
7. Add sandbox provider abstraction and one production sandbox implementation.
8. Add durable workflows and a queue-backed worker coordinator.
9. Add CI evidence and release approvals.
10. Only after integration tests pass, expose factory features to users.

## Non-goals for the first implementation slice

- No unrestricted shell access from the public web API.
- No executing generated code inside the Telegram Worker request.
- No production secrets mounted into coding sandboxes.
- No direct pushes to protected branches.
- No unattended production release.
- No claim of universal native mobile app generation until Expo/EAS pipeline is tested end-to-end.
