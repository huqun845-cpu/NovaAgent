# Phase 2A — AI Gateway Planning Adapter

This commit introduces the first real model-backed capability in the Factory: converting a validated requirement into a bounded, deterministic task DAG. It does not yet execute code, invoke a coding harness, schedule subagents, or persist an AI plan as a run.

## Implementation
- `src/factory/ai-planner.ts`: AI SDK 7 `generateText` adapter routed through the AI SDK's default Vercel AI Gateway provider.
- `src/factory/planning-http.ts`: bounded HTTP adapter for AI task planning.
- `src/factory/http.ts`: authenticated `POST /api/factory/plan` endpoint. Requires the `run:create` permission.
- `tests/factory-ai-planner.test.mjs`: verifies generated JSON, role allowlist, task count, duplicate IDs, unknown dependencies and cycle rejection.
- `package.json`: adds `ai@^7`.

## Endpoint
`POST /api/factory/plan`

Headers:
- `Authorization: Bearer <Factory JWT>`
- `Content-Type: application/json`

Body:
```json
{
  "spec": {
    "title": "Customer portal",
    "description": "Build a secure customer portal",
    "target": "fullstack",
    "acceptanceCriteria": ["Customers can sign in", "Admins can manage accounts"]
  }
}
```

The response contains a validated task DAG, the selected model ID, whether the configured fallback model was used, and token usage metadata. The plan endpoint does not persist a run. Run creation remains deterministic until the durable workflow phase wires planning into a background run step.

## Model and secret configuration
- `AI_GATEWAY_API_KEY`: required server-side Gateway API key. Never expose it to the browser or commit it.
- `FACTORY_PLANNER_MODEL`: required exact `provider/model` ID from the live AI Gateway model catalog.
- `FACTORY_PLANNER_FALLBACK_MODEL`: optional second exact model ID.
- The planner uses a 45-second default request timeout, a 6,000-token output ceiling and at most two configured model attempts.
- Model IDs are deliberately environment-configured rather than hard-coded because the Gateway catalog changes. Discover current IDs from `https://ai-gateway.vercel.sh/v1/models`.

Set secrets/config in the Cloudflare environment (do not put API keys in `wrangler.toml`):
```bash
npx wrangler secret put AI_GATEWAY_API_KEY
npx wrangler secret put FACTORY_PLANNER_MODEL
npx wrangler secret put FACTORY_PLANNER_FALLBACK_MODEL
```
For model IDs, use Cloudflare secrets or non-secret environment variables according to your deployment policy; never place the Gateway key in `[vars]`.

## Safety contract
- Requirement text is passed as data to a constrained planner prompt; it cannot grant tools or override application policy.
- Model output is untrusted. The adapter parses JSON, allows only known Agent roles, bounds the DAG to 40 tasks, validates IDs/dependencies and rejects cycles before returning it.
- This planner has no shell, filesystem, GitHub write, network, deployment or database tools.
- Provider fallback is bounded to the configured primary and optional fallback model; there is no unbounded retry loop.
- The API requires a signed Factory JWT and the `run:create` permission.
- The endpoint currently has request-size and timeout limits, but distributed per-user rate limiting and spend budgets are still required before public exposure.

## Verification status
The unit tests are committed but have not yet been run in a live CI job. No live Gateway request has been made, no API key has been provisioned, and no model ID has been selected or verified against the current catalog for this deployment. This commit is not a production deployment.

## Next Phase 2 work
1. Add durable model invocation records and token/cost accounting in PostgreSQL.
2. Add per-organization/user quotas and distributed rate limiting.
3. Add structured planning evaluation fixtures and model regression tests.
4. Add planner approval and persisted plan versioning.
5. Add coding-harness adapters behind a strict capability interface; do not give this planner execution tools.

## Phase 2B — Monthly token budget gate

The planner now requires an organization budget reservation before each model attempt:
- `migrations/factory/0003_ai_usage_budgets.sql` adds monthly input/output token budgets and an invocation ledger.
- `src/factory/ai-usage-ledger.ts` calls atomic Postgres RPC functions using the server-only service credential.
- Every attempt reserves estimated prompt tokens and the full 6,000-token output ceiling before calling the provider.
- On success, reported token usage settles the reservation. On failure after the provider call begins, the planner conservatively settles the full reservation instead of assuming the failed request was free.
- Missing budgets fail closed; exhausted budgets return HTTP 429. Budget rows are provisioned explicitly by an operator.

Provision one budget row per organization (example only; tune limits for the plan):
```sql
INSERT INTO factory_ai_budgets (
  organization_id, monthly_input_token_limit, monthly_output_token_limit
) VALUES (
  '<organization-uuid>', 5000000, 1000000
);
```

This is token quota accounting, not monetary billing. Exact currency cost still requires trusted per-provider pricing metadata and reconciliation against AI Gateway usage logs. No cost amount is fabricated by this implementation.
