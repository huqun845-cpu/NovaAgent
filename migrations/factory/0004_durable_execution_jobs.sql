-- Durable PostgreSQL-backed execution queue for the isolated Vercel Sandbox service.
-- A budget row must be provisioned for every organization before jobs can run.
CREATE TABLE factory_execution_budgets (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  monthly_limit_seconds BIGINT NOT NULL CHECK (monthly_limit_seconds > 0),
  monthly_used_seconds BIGINT NOT NULL DEFAULT 0 CHECK (monthly_used_seconds >= 0),
  reserved_seconds BIGINT NOT NULL DEFAULT 0 CHECK (reserved_seconds >= 0),
  active_count INTEGER NOT NULL DEFAULT 0 CHECK (active_count >= 0),
  max_concurrent INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrent BETWEEN 1 AND 32),
  period_start DATE NOT NULL DEFAULT date_trunc('month', now())::date,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE factory_execution_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  project_id UUID NOT NULL,
  run_id UUID NOT NULL,
  commit_sha CHAR(40) NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  checks JSONB NOT NULL DEFAULT '["type-check","test","build"]'::jsonb
    CHECK (jsonb_typeof(checks) = 'array'),
  status VARCHAR(16) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 5),
  idempotency_key VARCHAR(160) NOT NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner VARCHAR(160),
  lease_expires_at TIMESTAMPTZ,
  reserved_seconds INTEGER NOT NULL DEFAULT 0 CHECK (reserved_seconds >= 0),
  result JSONB,
  last_error TEXT,
  created_by VARCHAR(160) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, project_id, run_id)
    REFERENCES agent_runs(organization_id, project_id, id) ON DELETE CASCADE
);
CREATE INDEX factory_execution_jobs_ready
  ON factory_execution_jobs(available_at, created_at)
  WHERE status = 'queued';
CREATE INDEX factory_execution_jobs_expired
  ON factory_execution_jobs(lease_expires_at)
  WHERE status = 'running';

CREATE OR REPLACE FUNCTION factory_enqueue_execution_job(
  p_organization_id UUID,
  p_run_id UUID,
  p_actor_id TEXT,
  p_commit_sha TEXT,
  p_idempotency_key TEXT,
  p_checks JSONB DEFAULT '["type-check","test","build"]'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run agent_runs%ROWTYPE;
  v_project factory_projects%ROWTYPE;
  v_job factory_execution_jobs%ROWTYPE;
  v_checks JSONB := COALESCE(p_checks, '["type-check","test","build"]'::jsonb);
BEGIN
  IF p_commit_sha !~ '^[a-f0-9]{40}$' OR p_idempotency_key IS NULL
     OR length(p_idempotency_key) < 8 OR length(p_idempotency_key) > 160 THEN
    RAISE EXCEPTION 'INVALID_EXECUTION_INPUT';
  END IF;
  IF jsonb_typeof(v_checks) <> 'array' OR jsonb_array_length(v_checks) < 1
     OR jsonb_array_length(v_checks) > 4 THEN
    RAISE EXCEPTION 'INVALID_CHECK_SET';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(v_checks) x
    WHERE x NOT IN ('type-check','test','build','lint')
  ) OR (SELECT count(DISTINCT x) FROM jsonb_array_elements_text(v_checks) x) <> jsonb_array_length(v_checks) THEN
    RAISE EXCEPTION 'INVALID_CHECK_SET';
  END IF;

  SELECT * INTO v_run FROM agent_runs
  WHERE organization_id=p_organization_id AND id=p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RUN_NOT_FOUND'; END IF;
  IF v_run.status NOT IN ('queued','running','qa') THEN RAISE EXCEPTION 'RUN_NOT_EXECUTABLE'; END IF;
  SELECT * INTO v_project FROM factory_projects
  WHERE organization_id=p_organization_id AND id=v_run.project_id;
  IF NOT FOUND OR v_project.repository_full_name IS NULL THEN
    RAISE EXCEPTION 'PROJECT_REPOSITORY_NOT_CONFIGURED';
  END IF;

  INSERT INTO factory_execution_jobs(
    organization_id,project_id,run_id,commit_sha,checks,idempotency_key,created_by
  ) VALUES (
    p_organization_id,v_run.project_id,p_run_id,lower(p_commit_sha),v_checks,p_idempotency_key,p_actor_id
  ) ON CONFLICT (organization_id,idempotency_key) DO NOTHING;

  SELECT * INTO v_job FROM factory_execution_jobs
  WHERE organization_id=p_organization_id AND idempotency_key=p_idempotency_key;
  IF v_job.run_id <> p_run_id OR v_job.commit_sha <> lower(p_commit_sha) OR v_job.checks <> v_checks THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED';
  END IF;

  INSERT INTO audit_events(organization_id,actor_id,action,target_type,target_id,outcome,metadata)
  VALUES(p_organization_id,p_actor_id,'execution.enqueue','execution_job',v_job.id::text,'success',
    jsonb_build_object('run_id',p_run_id,'commit_sha',lower(p_commit_sha),'status',v_job.status))
  ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('id',v_job.id,'runId',v_job.run_id,'status',v_job.status,
    'attempts',v_job.attempts,'createdAt',v_job.created_at);
END $$;

CREATE OR REPLACE FUNCTION factory_reap_expired_execution_jobs()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job factory_execution_jobs%ROWTYPE;
  v_count INTEGER := 0;
BEGIN
  FOR v_job IN
    SELECT * FROM factory_execution_jobs
    WHERE status='running' AND lease_expires_at < now()
    ORDER BY lease_expires_at
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE factory_execution_budgets
      SET active_count=GREATEST(0,active_count-1),
          reserved_seconds=GREATEST(0,reserved_seconds-v_job.reserved_seconds),
          updated_at=now()
      WHERE organization_id=v_job.organization_id;
    UPDATE factory_execution_jobs
      SET status=CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
          available_at=now()+make_interval(secs => LEAST(300,15*GREATEST(attempts,1))),
          lease_owner=NULL,lease_expires_at=NULL,reserved_seconds=0,
          last_error='Execution lease expired; worker may have terminated',
          finished_at=CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
          updated_at=now()
      WHERE id=v_job.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION factory_claim_execution_job(
  p_worker_id TEXT,
  p_lease_seconds INTEGER DEFAULT 300,
  p_reservation_seconds INTEGER DEFAULT 240
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job factory_execution_jobs%ROWTYPE;
  v_budget factory_execution_budgets%ROWTYPE;
  v_repo TEXT;
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) < 1 OR length(p_worker_id) > 160
     OR p_lease_seconds NOT BETWEEN 60 AND 900
     OR p_reservation_seconds NOT BETWEEN 60 AND 600 THEN
    RAISE EXCEPTION 'INVALID_WORKER_CLAIM';
  END IF;
  PERFORM factory_reap_expired_execution_jobs();

  FOR v_job IN
    SELECT j.* FROM factory_execution_jobs j
    JOIN factory_execution_budgets b ON b.organization_id=j.organization_id
    WHERE j.status='queued' AND j.available_at <= now()
      AND b.period_start=date_trunc('month',now())::date
      AND b.monthly_used_seconds+b.reserved_seconds+p_reservation_seconds <= b.monthly_limit_seconds
      AND b.active_count < b.max_concurrent
    ORDER BY j.available_at,j.created_at
    FOR UPDATE OF j SKIP LOCKED
    LIMIT 1
  LOOP
    SELECT * INTO v_budget FROM factory_execution_budgets
      WHERE organization_id=v_job.organization_id FOR UPDATE;
    IF NOT FOUND OR v_budget.period_start <> date_trunc('month',now())::date
       OR v_budget.monthly_used_seconds+v_budget.reserved_seconds+p_reservation_seconds > v_budget.monthly_limit_seconds
       OR v_budget.active_count >= v_budget.max_concurrent THEN
      CONTINUE;
    END IF;
    SELECT repository_full_name INTO v_repo FROM factory_projects
      WHERE organization_id=v_job.organization_id AND id=v_job.project_id;
    IF v_repo IS NULL THEN
      UPDATE factory_execution_jobs SET status='failed',last_error='Project repository is no longer configured',
        finished_at=now(),updated_at=now() WHERE id=v_job.id;
      CONTINUE;
    END IF;
    UPDATE factory_execution_budgets SET active_count=active_count+1,
      reserved_seconds=reserved_seconds+p_reservation_seconds,updated_at=now()
      WHERE organization_id=v_job.organization_id;
    UPDATE factory_execution_jobs SET status='running',attempts=attempts+1,
      lease_owner=p_worker_id,lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
      reserved_seconds=p_reservation_seconds,started_at=COALESCE(started_at,now()),updated_at=now()
      WHERE id=v_job.id RETURNING * INTO v_job;
    RETURN jsonb_build_object('id',v_job.id,'organizationId',v_job.organization_id,
      'projectId',v_job.project_id,'runId',v_job.run_id,'repositoryFullName',v_repo,
      'commitSha',v_job.commit_sha,'checks',v_job.checks,'attempt',v_job.attempts,
      'maxAttempts',v_job.max_attempts,'workerId',p_worker_id,'timeoutMs',180000);
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION factory_finish_execution_job(
  p_job_id UUID,
  p_worker_id TEXT,
  p_status TEXT,
  p_result JSONB,
  p_error TEXT DEFAULT NULL,
  p_runtime_seconds INTEGER DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job factory_execution_jobs%ROWTYPE;
  v_budget factory_execution_budgets%ROWTYPE;
  v_next_status TEXT;
  v_actual INTEGER;
BEGIN
  IF p_status NOT IN ('succeeded','failed') OR p_runtime_seconds < 0 THEN
    RAISE EXCEPTION 'INVALID_EXECUTION_RESULT';
  END IF;
  SELECT * INTO v_job FROM factory_execution_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EXECUTION_JOB_NOT_FOUND'; END IF;
  IF v_job.status <> 'running' OR v_job.lease_owner <> p_worker_id THEN
    RAISE EXCEPTION 'EXECUTION_LEASE_LOST';
  END IF;
  SELECT * INTO v_budget FROM factory_execution_budgets
    WHERE organization_id=v_job.organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EXECUTION_BUDGET_NOT_CONFIGURED'; END IF;
  v_actual := LEAST(p_runtime_seconds,v_job.reserved_seconds);
  UPDATE factory_execution_budgets SET active_count=GREATEST(0,active_count-1),
    reserved_seconds=GREATEST(0,reserved_seconds-v_job.reserved_seconds),
    monthly_used_seconds=monthly_used_seconds+v_actual,updated_at=now()
    WHERE organization_id=v_job.organization_id;

  v_next_status := CASE
    WHEN p_status='succeeded' THEN 'succeeded'
    WHEN v_job.attempts < v_job.max_attempts THEN 'queued'
    ELSE 'failed' END;
  UPDATE factory_execution_jobs SET status=v_next_status,
    available_at=CASE WHEN v_next_status='queued' THEN now()+make_interval(secs=>LEAST(300,15*v_job.attempts)) ELSE available_at END,
    result=p_result,last_error=left(COALESCE(p_error,''),4000),
    lease_owner=NULL,lease_expires_at=NULL,reserved_seconds=0,
    finished_at=CASE WHEN v_next_status IN ('succeeded','failed') THEN now() ELSE NULL END,
    updated_at=now()
    WHERE id=p_job_id RETURNING * INTO v_job;

  INSERT INTO workflow_events(organization_id,run_id,event_type,event_key,payload)
  VALUES(v_job.organization_id,v_job.run_id,'execution.'||v_next_status,
    'execution.'||v_job.id::text||'.attempt.'||v_job.attempts,
    jsonb_build_object('job_id',v_job.id,'attempt',v_job.attempts,'runtime_seconds',v_actual,'error',left(COALESCE(p_error,''),1000)))
  ON CONFLICT (run_id,event_key) DO NOTHING;
  INSERT INTO audit_events(organization_id,actor_id,action,target_type,target_id,outcome,metadata)
  VALUES(v_job.organization_id,'system:executor','execution.finish','execution_job',v_job.id::text,
    CASE WHEN v_next_status='succeeded' THEN 'success' ELSE 'failure' END,
    jsonb_build_object('status',v_next_status,'attempt',v_job.attempts,'runtime_seconds',v_actual));
  RETURN jsonb_build_object('id',v_job.id,'status',v_job.status,'attempts',v_job.attempts,
    'finishedAt',v_job.finished_at,'availableAt',v_job.available_at);
END $$;

REVOKE ALL ON FUNCTION factory_enqueue_execution_job(UUID,UUID,TEXT,TEXT,TEXT,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION factory_reap_expired_execution_jobs() FROM PUBLIC;
REVOKE ALL ON FUNCTION factory_claim_execution_job(TEXT,INTEGER,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION factory_finish_execution_job(UUID,TEXT,TEXT,JSONB,TEXT,INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION factory_enqueue_execution_job(UUID,UUID,TEXT,TEXT,TEXT,JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION factory_reap_expired_execution_jobs() TO service_role;
GRANT EXECUTE ON FUNCTION factory_claim_execution_job(TEXT,INTEGER,INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION factory_finish_execution_job(UUID,TEXT,TEXT,JSONB,TEXT,INTEGER) TO service_role;
