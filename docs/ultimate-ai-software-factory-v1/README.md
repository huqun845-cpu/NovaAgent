# Ultimate AI Software Factory V1.0

> Cloud-first autonomous software delivery platform. This directory establishes the V1.0 product and engineering blueprint inside a dedicated feature branch. It does not claim that the full factory runtime has been implemented.

## Repository decision

Use the existing `NovaAgent` repository as the **initial agent-runtime foundation**, not as the final product boundary.

Why:
- It already runs on Cloudflare Workers and TypeScript.
- It has a multi-step agent/tool execution model, Gemini integration, persistent memory, web-app generation/hosting, and a dashboard surface.
- It is materially closer to the requested cloud-native agent factory than the local-first AIOS repository.

Important boundaries:
- Keep the existing Nova Telegram product working.
- Build the factory as a separately namespaced subsystem with its own API, data model, authorization, job lifecycle, and UI.
- Do not treat a generated single-file HTML app as equivalent to a tested software project.
- Do not run untrusted generated code inside the Cloudflare request worker.
- Do not automatically publish production releases. Production deployment requires explicit approval.

## Product objective

Natural-language request → requirements → architecture → task plan → isolated code generation → tests → security checks → preview deployment → human approval → production deployment → monitoring and rollback.

V1.0 target: web applications and APIs first. Mobile builds (Expo/EAS), native packaging, and broader provider integrations are planned extension points, not V1.0 completion claims.

## V1.0 scope

1. Project workspace and GitHub repository binding.
2. Requirements intake and structured specification.
3. Agent planner and durable workflow state machine.
4. Provider adapter interface for planning, coding, review, and repair.
5. Cloud job queue and isolated ephemeral execution workers.
6. Git branch/commit/PR workflow; never write directly to the production branch.
7. Automated quality gates: formatting, type checks, unit tests, integration tests, dependency audit, secret scan, and build.
8. Preview deployment and artifact storage.
9. Approval inbox for merge and production release.
10. Audit trail, usage/cost tracking, observability, backup, and rollback.

## Architecture decisions

- **Control plane:** Cloudflare Workers for authenticated API, workflow orchestration, webhooks, and lightweight control operations.
- **Durable orchestration:** Cloudflare Workflows (or a provider-neutral workflow adapter) for retryable multi-step processes.
- **Queue:** Cloudflare Queues for asynchronous job dispatch.
- **Metadata:** D1 initially; keep repository and service interfaces portable so PostgreSQL can be introduced for multi-tenant scale.
- **Artifacts:** R2 for logs, test reports, build artifacts, and generated previews.
- **Execution plane:** isolated remote build workers / microVM or container sandbox. Workers runtime is not the untrusted-code sandbox.
- **Source control:** GitHub App with least-privilege installation permissions.
- **Web deployment:** Vercel adapter first; Cloudflare Pages adapter as an alternative.
- **AI:** provider-neutral adapter; Gemini can remain the existing Nova default, with OpenAI/Anthropic/other providers added behind explicit configuration.
- **Secrets:** Worker secrets for control-plane credentials; short-lived scoped credentials for workers. Never store provider secrets in prompts, generated files, or Git.

## Repository layout target

```text
src/
  factory/
    api/             # authenticated factory endpoints
    auth/            # users, organizations, roles, policies
    projects/        # workspace and repository bindings
    specs/           # requirements and acceptance criteria
    planner/         # plan generation and validation
    agents/          # provider interfaces and role-specific agents
    workflows/       # durable state machine and transitions
    jobs/            # queue producers and consumers
    github/          # app installation, branch, PR, webhook adapters
    quality/         # test, lint, audit, secret-scan gates
    deploy/          # preview/prod deployment adapters
    approvals/       # merge/release approvals
    audit/           # immutable event records
    usage/           # tokens, time, cost, quotas
    shared/          # schemas, errors, ids, policy helpers
  factory-dashboard/ # independent web control center
  index.ts           # existing Nova entry point; integrate by routing only
migrations/
  factory/
workers/
  executor/          # separate isolated execution service/repository boundary
tests/
  factory/
docs/
  ultimate-ai-software-factory-v1/
```

## Workflow state machine

`received → clarifying → specified → planned → awaiting_plan_approval → queued → executing → validating → repairing → preview_ready → awaiting_release_approval → deploying → deployed`

Terminal or exceptional states: `cancelled`, `failed`, `blocked_security`, `rolled_back`.

Every transition must be validated server-side and appended to an audit/event log. Retries must be idempotent. A failed quality gate cannot advance to preview-ready. A production deployment cannot start without a valid approval record.

## Delivery phases

- **V1.0-A Foundation:** schemas, project/workspace model, authz, workflow state machine, audit events, provider interfaces, migrations, tests.
- **V1.0-B GitHub integration:** GitHub App, repository binding, branch creation, commit/PR, signed webhook validation.
- **V1.0-C Cloud execution:** queue, isolated worker, resource limits, no privileged host mounts, controlled egress, artifact upload.
- **V1.0-D QA and preview:** deterministic quality gates, repair loop with bounded attempts, preview deployment, test evidence.
- **V1.0-E Release governance:** approval inbox, production deploy adapter, rollback, audit export, quotas and cost reporting.
- **V1.1:** multi-model routing, browser-based E2E tests, Expo/EAS mobile builds, templates and reusable project blueprints.

## Definition of done

A feature is not complete merely because source files exist. Each phase must include:
- migrations and rollback strategy;
- API schemas and authorization tests;
- unit and integration tests;
- failure/retry/idempotency tests;
- security checks and threat-model updates;
- reproducible deployment instructions;
- evidence from CI runs.

## License and reuse note

The host repository is licensed AGPL-3.0-or-later. Before distributing a hosted or modified combined product, review AGPL obligations and third-party service terms. This blueprint does not change the repository license.
