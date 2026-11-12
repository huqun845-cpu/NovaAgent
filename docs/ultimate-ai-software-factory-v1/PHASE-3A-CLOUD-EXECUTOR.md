# Phase 3A — Isolated Cloud Repository Checks

The first cloud execution slice is implemented as a separate Node.js 22+ Vercel project under `services/factory-executor`. It uses the Vercel Sandbox SDK (Firecracker microVMs) and is deliberately not bundled into the existing Cloudflare Worker.

## Components
- `services/factory-executor/src/sandbox-runner.ts`: isolated repository checkout and fixed npm check runner.
- `services/factory-executor/api/execute.ts`: authenticated execution endpoint; derives the repository from the organization's persisted run/project records.
- `services/factory-executor/package.json`: independent dependency boundary with `@vercel/sandbox` 3.x.
- `services/factory-executor/tests/sandbox-runner.test.mjs`: mocked contract tests for sandbox creation, immutable SHA validation, egress lockdown and cleanup.
- `services/factory-executor/README.md`: separate Vercel project setup and environment configuration.

## Execution boundary
1. Authenticate a Factory JWT and allow only owner/admin/architect/engineer/qa roles.
2. Resolve run and project by the actor's organization ID; never accept a clone URL from the caller.
3. Require an immutable 40-character commit SHA.
4. Create a non-persistent Node 22 Sandbox with a 3-minute timeout.
5. Permit egress only to GitHub source hosts and npm registry during checkout/dependency installation.
6. Switch the sandbox to `deny-all` before executing project scripts.
7. Execute only existing `type-check`, `test`, `build`, and `lint` npm scripts; no arbitrary command string is accepted.
8. Bound captured output and stop the microVM in `finally`.

## Endpoint
`POST /api/execute` (deployed separately from the Factory Worker). Request body:
```json
{
  "runId": "00000000-0000-4000-8000-000000000001",
  "commitSha": "0123456789abcdef0123456789abcdef01234567",
  "checks": ["type-check", "test", "build"]
}
```

## Important limitations
- The repository must currently be public. Private-repository checkout needs a brokered GitHub credential path; no GitHub token is injected into the VM.
- This first endpoint is synchronous and limited to 180 seconds; long-running builds and agent loops must move to a durable workflow.
- It is a deterministic check runner, not yet a coding agent: no patch editing, branch push, PR creation or preview deployment.
- The Cloudflare control plane does not yet call this executor. Service-to-service dispatch, durable job state, concurrency quotas and execution accounting remain next.
- The Vercel project is not provisioned or deployed, and no live Sandbox run has been performed.

## Verification
GitHub Actions now installs, type-checks and tests this isolated package in addition to the existing Worker checks. The latest workflow must complete successfully before this slice is considered CI-verified.
