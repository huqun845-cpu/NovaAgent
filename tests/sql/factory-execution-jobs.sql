\set ON_ERROR_STOP on

DO $$
DECLARE
  v_org UUID := '11111111-1111-4111-8111-111111111111';
  v_project UUID := '22222222-2222-4222-8222-222222222222';
  v_spec UUID := '33333333-3333-4333-8333-333333333333';
  v_run1 UUID := '44444444-4444-4444-8444-444444444441';
  v_run2 UUID := '44444444-4444-4444-8444-444444444442';
  v_run3 UUID := '44444444-4444-4444-8444-444444444443';
  v_org2 UUID := '77777777-7777-4777-8777-777777777777';
  v_project2 UUID := '88888888-8888-4888-8888-888888888888';
  v_spec2 UUID := '99999999-9999-4999-8999-999999999999';
  v_run4 UUID := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_job JSONB;
  v_claim JSONB;
  v_finish JSONB;
  v_job_id UUID;
  v_status TEXT;
  v_attempt INTEGER;
  v_active INTEGER;
  v_reserved BIGINT;
  v_used BIGINT;
BEGIN
  INSERT INTO organizations(id,name,slug) VALUES(v_org,'CI Factory','ci-factory');
  INSERT INTO factory_projects(id,organization_id,name,repository_full_name,created_by)
    VALUES(v_project,v_org,'CI Project','acme/public-repo','ci');
  INSERT INTO requirement_specs(id,organization_id,project_id,version,title,description,target,acceptance_criteria,created_by)
    VALUES(v_spec,v_org,v_project,1,'CI Requirement','Validate durable execution queue','api','["checks run"]'::jsonb,'ci');
  INSERT INTO agent_runs(id,organization_id,project_id,spec_id,status,idempotency_key,created_by)
    VALUES
      (v_run1,v_org,v_project,v_spec,'queued','ci-run-key-0001','ci'),
      (v_run2,v_org,v_project,v_spec,'queued','ci-run-key-0002','ci'),
      (v_run3,v_org,v_project,v_spec,'queued','ci-run-key-0003','ci');
  INSERT INTO factory_execution_budgets(organization_id,monthly_limit_seconds,max_concurrent)
    VALUES(v_org,10000,1);

  -- Enqueue is idempotent and the database derives repository identity from the run/project.
  v_job := factory_enqueue_execution_job(v_org,v_run1,'ci-user',repeat('a',40),'ci-exec-key-0001','["type-check","test"]'::jsonb);
  v_job_id := (v_job->>'id')::uuid;
  IF v_job->>'status' <> 'queued' THEN RAISE EXCEPTION 'expected queued job'; END IF;

  -- Per-organization max_concurrent=1 is enforced atomically.
  v_claim := factory_claim_execution_job('ci-worker-1',300,240);
  IF v_claim IS NULL OR v_claim->>'id' <> v_job_id::text THEN RAISE EXCEPTION 'worker did not claim expected job'; END IF;
  IF factory_claim_execution_job('ci-worker-2',300,240) IS NOT NULL THEN
    RAISE EXCEPTION 'concurrency limit was bypassed';
  END IF;

  v_finish := factory_finish_execution_job(v_job_id,'ci-worker-1','succeeded','{"status":"passed"}'::jsonb,NULL,13);
  IF v_finish->>'status' <> 'succeeded' THEN RAISE EXCEPTION 'success was not persisted'; END IF;
  UPDATE agent_runs SET status='succeeded' WHERE id=v_run1;
  v_job := factory_enqueue_execution_job(v_org,v_run1,'ci-user',repeat('a',40),'ci-exec-key-0001','["type-check","test"]'::jsonb);
  IF (v_job->>'id')::uuid <> v_job_id THEN RAISE EXCEPTION 'terminal idempotency replay created a duplicate'; END IF;

  -- Failed attempts are retried with a bounded maximum, then become terminal.
  v_job := factory_enqueue_execution_job(v_org,v_run2,'ci-user',repeat('b',40),'ci-exec-key-0002','["test"]'::jsonb);
  v_job_id := (v_job->>'id')::uuid;
  FOR v_attempt IN 1..3 LOOP
    v_claim := factory_claim_execution_job('ci-retry-worker-'||v_attempt,300,240);
    IF v_claim IS NULL OR (v_claim->>'id')::uuid <> v_job_id THEN RAISE EXCEPTION 'retry attempt % was not claimed',v_attempt; END IF;
    v_finish := factory_finish_execution_job(v_job_id,'ci-retry-worker-'||v_attempt,'failed','{"status":"failed"}'::jsonb,'expected test failure',1);
    IF v_attempt < 3 THEN
      IF v_finish->>'status' <> 'queued' THEN RAISE EXCEPTION 'attempt % should be queued for retry',v_attempt; END IF;
      UPDATE factory_execution_jobs SET available_at=now()-interval '1 second' WHERE id=v_job_id;
    ELSE
      IF v_finish->>'status' <> 'failed' THEN RAISE EXCEPTION 'max attempts did not become terminal'; END IF;
    END IF;
  END LOOP;

  -- Expired worker leases are reaped, charged conservatively, and can be reclaimed.
  v_job := factory_enqueue_execution_job(v_org,v_run3,'ci-user',repeat('c',40),'ci-exec-key-0003','["type-check"]'::jsonb);
  v_job_id := (v_job->>'id')::uuid;
  v_claim := factory_claim_execution_job('ci-crashed-worker',300,240);
  IF (v_claim->>'id')::uuid <> v_job_id THEN RAISE EXCEPTION 'lease test job was not claimed'; END IF;
  UPDATE factory_execution_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=v_job_id;
  v_claim := factory_claim_execution_job('ci-recovery-worker',300,240);
  IF v_claim IS NULL OR (v_claim->>'id')::uuid <> v_job_id OR (v_claim->>'attempt')::integer <> 2 THEN
    RAISE EXCEPTION 'expired lease was not reaped and reclaimed';
  END IF;
  PERFORM factory_finish_execution_job(v_job_id,'ci-recovery-worker','succeeded','{"status":"passed"}'::jsonb,NULL,2);

  SELECT active_count,reserved_seconds,monthly_used_seconds
    INTO v_active,v_reserved,v_used FROM factory_execution_budgets WHERE organization_id=v_org;
  IF v_active <> 0 OR v_reserved <> 0 OR v_used < 255 THEN
    RAISE EXCEPTION 'execution budget counters inconsistent: active %, reserved %, used %',v_active,v_reserved,v_used;
  END IF;

  -- Missing budget rows fail closed: enqueue persists, but the worker cannot claim it.
  INSERT INTO organizations(id,name,slug) VALUES(v_org2,'No Budget Org','no-budget-org');
  INSERT INTO factory_projects(id,organization_id,name,repository_full_name,created_by)
    VALUES(v_project2,v_org2,'No Budget Project','acme/no-budget','ci');
  INSERT INTO requirement_specs(id,organization_id,project_id,version,title,description,target,acceptance_criteria,created_by)
    VALUES(v_spec2,v_org2,v_project2,1,'No Budget','Fail closed','api','["not claimed"]'::jsonb,'ci');
  INSERT INTO agent_runs(id,organization_id,project_id,spec_id,status,idempotency_key,created_by)
    VALUES(v_run4,v_org2,v_project2,v_spec2,'queued','ci-run-key-0004','ci');
  PERFORM factory_enqueue_execution_job(v_org2,v_run4,'ci-user',repeat('d',40),'ci-exec-key-0004','["test"]'::jsonb);
  IF factory_claim_execution_job('ci-no-budget-worker',300,240) IS NOT NULL THEN
    RAISE EXCEPTION 'execution without an organization budget must not be claimed';
  END IF;
END $$;
