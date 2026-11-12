# Factory Cloud Executor

A separate Node.js 22+ Vercel project for running repository checks inside Vercel Sandbox Firecracker microVMs. It is intentionally isolated from the existing Cloudflare Worker / Telegram runtime.

## Deploy as a separate Vercel project

Create a Vercel project and set its **Root Directory** to `services/factory-executor`. The Vercel deployment must use Node.js 22 or later so the Sandbox SDK can authenticate through the deployment's Vercel OIDC identity.

Configure these server-only environment variables in Vercel:
- `FACTORY_AUTH_SECRET`
- `FACTORY_AUTH_ISSUER`
- `FACTORY_AUTH_AUDIENCE`
- `FACTORY_DATABASE_REST_URL`
- `FACTORY_DATABASE_SERVICE_KEY`

Do not add the database service key or JWT signing secret to client-side variables. The Sandbox SDK obtains its own Vercel OIDC credentials from the deployed Vercel runtime; no Vercel token is copied into the sandbox.

## Endpoint

`POST /api/execute`

Headers:
- `Authorization: Bearer <Factory JWT>`
- `Content-Type: application/json`

Body:
```json
{
  "runId": "00000000-0000-4000-8000-000000000001",
  "commitSha": "0123456789abcdef0123456789abcdef01234567",
  "checks": ["type-check", "test", "build"]
}
```

The API derives the repository from the authenticated organization's persisted project/run records. The caller cannot supply an arbitrary clone URL or shell command. The commit must be a full 40-character SHA. Only owner/admin/architect/engineer/qa roles can invoke it.

Supported checks map to existing `package.json` scripts: `type-check`, `test`, `build`, and `lint`. Missing scripts are skipped; if no requested check can run, the overall result fails.

## Isolation sequence

1. Create a one-off sandbox with a pinned Node 22 image, 2 vCPUs, a 3-minute timeout and `persistent: false`.
2. Checkout the immutable commit from the project's public GitHub repository.
3. Install dependencies with a narrow egress allowlist: GitHub source hosts and npm registry only.
4. Change sandbox egress to `deny-all` before executing repository scripts.
5. Execute only the fixed npm script allowlist; no caller-supplied command, shell string, token or environment variable is forwarded.
6. Capture bounded stdout/stderr and exit codes.
7. Stop the sandbox in `finally`; its filesystem is discarded.

This is a first CI/check-runner slice, not yet a full autonomous coding agent. It does not edit files, push branches, open PRs, deploy previews, or run arbitrary commands. Private GitHub repositories are intentionally unsupported until a credential-brokered checkout path is implemented.

## Local validation

```bash
npm install
npm run type-check
npm test
```

For local Sandbox calls, link the Vercel project and pull development environment variables using the Vercel CLI. The deployed Vercel runtime uses OIDC automatically.

## Current limitations / next gates

- This service is not yet called by the Cloudflare Factory Worker; service-to-service invocation and durable job dispatch are the next integration step.
- Runs are synchronous and capped at 180 seconds in this first endpoint. Move execution into a durable workflow before supporting long-running builds or agent loops.
- There is no executor-specific concurrency or spend quota yet.
- Private repositories, write-capable GitHub credentials, patch application and branch/PR creation are disabled.
- No live Vercel project has been provisioned and no sandbox has been created in this deployment.
