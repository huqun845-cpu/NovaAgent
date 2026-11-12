-- Ultimate AI Software Factory control plane schema (PostgreSQL).
-- Deliberately separate from NovaAgent's existing Cloudflare D1 database.
-- Apply only to a newly provisioned Factory PostgreSQL database.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(160) NOT NULL,
  slug VARCHAR(80) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id VARCHAR(160) NOT NULL,
  role VARCHAR(24) NOT NULL CHECK (role IN ('owner','admin','architect','engineer','qa','reviewer','viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE factory_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  repository_full_name VARCHAR(255),
  default_branch VARCHAR(255) NOT NULL DEFAULT 'main',
  created_by VARCHAR(160) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
CREATE INDEX factory_projects_org_updated ON factory_projects(organization_id, updated_at DESC);

CREATE TABLE requirement_specs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  title VARCHAR(160) NOT NULL,
  description TEXT NOT NULL,
  target VARCHAR(16) NOT NULL CHECK (target IN ('web','api','desktop','mobile','fullstack')),
  acceptance_criteria JSONB NOT NULL CHECK (jsonb_typeof(acceptance_criteria) = 'array'),
  constraints JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by VARCHAR(160) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES factory_projects(organization_id, id) ON DELETE CASCADE,
  UNIQUE (project_id, version),
  UNIQUE (organization_id, project_id, id)
);

CREATE TABLE agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  spec_id UUID NOT NULL,
  status VARCHAR(24) NOT NULL CHECK (status IN ('queued','planning','running','qa','awaiting_approval','succeeded','failed','cancelled')),
  idempotency_key VARCHAR(160) NOT NULL,
  created_by VARCHAR(160) NOT NULL,
  budget_limit_cents INTEGER NOT NULL DEFAULT 0 CHECK (budget_limit_cents >= 0),
  usage_cents INTEGER NOT NULL DEFAULT 0 CHECK (usage_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES factory_projects(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, project_id, spec_id) REFERENCES requirement_specs(organization_id, project_id, id),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX agent_runs_project_created ON agent_runs(project_id, created_at DESC);

CREATE TABLE workflow_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id UUID NOT NULL,
  task_key VARCHAR(80) NOT NULL,
  title VARCHAR(160) NOT NULL,
  description TEXT NOT NULL,
  role VARCHAR(24) NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('blocked','ready','running','succeeded','failed','cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, task_key),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, run_id, id),
  FOREIGN KEY (organization_id, run_id) REFERENCES agent_runs(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX workflow_tasks_run_status ON workflow_tasks(run_id, status);

CREATE TABLE workflow_dependencies (
  organization_id UUID NOT NULL,
  run_id UUID NOT NULL,
  task_id UUID NOT NULL,
  depends_on_task_id UUID NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id),
  FOREIGN KEY (organization_id, run_id) REFERENCES agent_runs(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, run_id, task_id) REFERENCES workflow_tasks(organization_id, run_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, run_id, depends_on_task_id) REFERENCES workflow_tasks(organization_id, run_id, id) ON DELETE CASCADE
);

CREATE TABLE workflow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id UUID NOT NULL,
  task_id UUID REFERENCES workflow_tasks(id) ON DELETE SET NULL,
  event_type VARCHAR(80) NOT NULL,
  event_key VARCHAR(160) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, event_key),
  FOREIGN KEY (organization_id, run_id) REFERENCES agent_runs(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX workflow_events_run_created ON workflow_events(run_id, created_at);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id VARCHAR(160) NOT NULL,
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(80) NOT NULL,
  target_id VARCHAR(160) NOT NULL,
  outcome VARCHAR(16) NOT NULL CHECK (outcome IN ('success','denied','failure')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org_created ON audit_events(organization_id, created_at DESC);

CREATE TABLE release_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  run_id UUID NOT NULL,
  commit_sha CHAR(40) NOT NULL,
  environment VARCHAR(16) NOT NULL CHECK (environment IN ('preview','production')),
  requested_by VARCHAR(160) NOT NULL,
  decided_by VARCHAR(160),
  decision VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','approved','rejected','expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES factory_projects(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, run_id) REFERENCES agent_runs(organization_id, id) ON DELETE CASCADE,
  CHECK (environment <> 'production' OR decision <> 'approved' OR decided_by IS NOT NULL)
);
CREATE INDEX release_approvals_pending ON release_approvals(organization_id, expires_at) WHERE decision = 'pending';
