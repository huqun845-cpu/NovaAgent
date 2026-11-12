# Phase 1B — API, Authentication and Persistence Adapter

This phase adds an isolated HTTP handler and a PostgREST-backed PostgreSQL repository. It is intentionally not mounted into the existing Nova Telegram Worker router yet: the existing Worker entrypoint and deployment path must be reviewed before adding routes, and the Factory must not change bot behavior by accident.

## New code
- `src/factory/auth.ts`: HS256 JWT verification using WebCrypto. Requires issuer, audience, expiry, subject, organization claim and one of the known Factory roles.
- `src/factory/postgrest-repository.ts`: tenant-filtered project/run reads and transactional RPC calls.
- `src/factory/http.ts`: HTTP routes for health, project list/create, run create and run detail.
- `migrations/factory/0002_control_plane_rpc.sql`: transaction-safe project/run creation RPCs, dependency persistence and audit events.
- `tests/factory-auth.test.mjs`: signed-token, expiry, signature and role rejection tests.

## HTTP routes
All routes except the unauthenticated health check require `Authorization: Bearer <JWT>`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/factory/health` | Liveness |
| GET | `/api/factory/projects` | List current organization projects |
| POST | `/api/factory/projects` | Create project (owner/admin/architect) |
| POST | `/api/factory/runs` | Create run; requires `Idempotency-Key` |
| GET | `/api/factory/runs/:uuid` | Read run in current organization |

Run request body:
```json
{
  "projectId": "project-uuid",
  "spec": {
    "title": "Customer portal",
    "description": "Build a secure customer portal",
    "target": "fullstack",
    "acceptanceCriteria": ["A customer can sign in"]
  }
}
```

Project request body:
```json
{
  "name": "Customer Portal",
  "repositoryFullName": "owner/repository",
  "defaultBranch": "main"
}
```

## Authentication contract
The identity provider must issue an HS256 JWT with:
- `iss`: exactly `FACTORY_AUTH_ISSUER`
- `aud`: exactly `FACTORY_AUTH_AUDIENCE`
- `sub`: stable user ID
- `org_id`: organization UUID
- `role`: owner, admin, architect, engineer, qa, reviewer, or viewer
- `exp`: expiry in Unix seconds

The HMAC secret must be at least 32 characters. This is a replaceable adapter contract, not a complete hosted identity product. Prefer an external OIDC provider in the next hardening phase; do not mint production JWTs in a browser or expose the HMAC secret to clients.

## Database and secrets
1. Provision a dedicated Supabase/PostgREST PostgreSQL project for the Factory; do not reuse Nova D1.
2. Apply migrations in order: `0001_control_plane.sql`, then `0002_control_plane_rpc.sql`.
3. Ensure the PostgREST `service_role` can execute the RPC functions. Keep its key only in Worker Secrets.
4. Set Worker secrets (never commit their values):
```bash
npx wrangler secret put FACTORY_AUTH_SECRET
npx wrangler secret put FACTORY_AUTH_ISSUER
npx wrangler secret put FACTORY_AUTH_AUDIENCE
npx wrangler secret put FACTORY_DATABASE_REST_URL
npx wrangler secret put FACTORY_DATABASE_SERVICE_KEY
```
5. The Worker adapter must pass those bindings to `handleFactoryRequest(request, env)` after the existing Telegram webhook routing has been preserved.

## Security notes
- The PostgREST service key is privileged. The API must always derive organization/user/role from the verified JWT, never from request JSON.
- Repository reads include organization filters; RPCs receive the verified organization ID and write the audit trail in the same database transaction.
- The health route intentionally exposes only liveness, not configuration or dependency details.
- Do not enable wildcard CORS for this API.
- Do not deploy until issuer/audience, secret rotation, database grants, tenant isolation and integration tests are verified.

## Remaining Phase 1B work
- Mount the handler into the Worker without changing existing Telegram routing.
- Connect a real OIDC identity provider and membership lookup; current JWT role claim is a signed adapter contract.
- Run PostgreSQL migrations against a disposable staging database and execute integration tests against real PostgREST.
- Add pagination, rate limiting, audit query API, organization/member management and dashboard UI.
- Run `npm run type-check`, `npm test` and `npm run validate` in CI. These commands have not been executed by this GitHub-only commit workflow.
