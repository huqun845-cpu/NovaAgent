# Phase 1 — Control Plane Foundation

This commit introduces the first isolated Factory domain layer. It does not alter the Telegram webhook, Nova D1 schema, or production Worker routing.

## Added
- Pure domain contracts and validation in `src/factory/domain.ts`.
- Deterministic starter DAG planner in `src/factory/planner.ts`. LLM output will later be validated against the same contract.
- PostgreSQL schema in `migrations/factory/0001_control_plane.sql`, intentionally separate from Nova's existing D1 database.
- Tests for spec validation, DAG cycles, runnable task selection, state transitions, RBAC and tenant boundaries.

## Important security properties
- Every persisted project/run/task/event is organization-scoped.
- Membership roles are explicit; only owner/admin have release approval permission in the starter matrix.
- A task graph is rejected if IDs are duplicated, dependencies are unknown, self-referential or cyclic.
- Run state transitions are allow-listed; terminal runs cannot be reopened.
- Release approvals are tied to a commit SHA and expire.
- The schema does not store provider secrets or GitHub installation tokens.

## Apply schema
Provision a dedicated PostgreSQL database for the Factory. Do not point this migration at Nova's existing D1 database.

Apply with your PostgreSQL migration runner, for example:
```bash
psql "$FACTORY_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/factory/0001_control_plane.sql
```

Do not run against production until a separate staging database has passed migration and restore tests.

## Local tests
```bash
node --experimental-loader ./tests/ts-resolve.mjs --test tests/factory.test.mjs
```

## Not implemented yet
- Authenticated HTTP routes/dashboard.
- PostgreSQL driver and repository implementation.
- Model gateway / AI SDK adapter.
- Durable workflow engine and coding sandbox.
- GitHub App installation flow and preview deployment.
These are subsequent phases; the presence of schema/domain contracts does not imply these services are deployed.
