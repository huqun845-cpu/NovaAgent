-- Factory PostgREST RPC layer. Apply after 0001_control_plane.sql.
-- Functions are callable only by the database service role; the Worker keeps
-- the service credential in a Cloudflare Secret and enforces end-user JWT/RBAC.
CREATE OR REPLACE FUNCTION factory_create_project(
  p_organization_id UUID,
  p_actor_id TEXT,
  p_name TEXT,
  p_repository_full_name TEXT DEFAULT NULL,
  p_default_branch TEXT DEFAULT 'main'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_project factory_projects%ROWTYPE;
BEGIN
  IF length(trim(p_name)) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'INVALID_PROJECT_NAME'; END IF;
  IF p_default_branch !~ '^[A-Za-z0-9._/-]{1,255}$' THEN RAISE EXCEPTION 'INVALID_DEFAULT_BRANCH'; END IF;
  INSERT INTO factory_projects(organization_id,name,repository_full_name,default_branch,created_by)
  VALUES(p_organization_id,trim(p_name),p_repository_full_name,p_default_branch,p_actor_id)
  RETURNING * INTO v_project;
  INSERT INTO audit_events(organization_id,actor_id,action,target_type,target_id,outcome,metadata)
  VALUES(p_organization_id,p_actor_id,'project.create','project',v_project.id::text,'success',
    jsonb_build_object('name',v_project.name));
  RETURN jsonb_build_object(
    'id',v_project.id,'organization_id',v_project.organization_id,'name',v_project.name,
    'repository_full_name',v_project.repository_full_name,'default_branch',v_project.default_branch
  );
END $$;

CREATE OR REPLACE FUNCTION factory_get_run_by_idempotency(
  p_organization_id UUID, p_idempotency_key TEXT
) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'id',r.id,'organization_id',r.organization_id,'project_id',r.project_id,
    'created_by',r.created_by,'idempotency_key',r.idempotency_key,'status',r.status,
    'created_at',r.created_at,'spec',jsonb_build_object(
      'title',s.title,'description',s.description,'target',s.target,
      'acceptanceCriteria',s.acceptance_criteria,'constraints',s.constraints
    ),
    'tasks',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'task_key',t.task_key,'title',t.title,'description',t.description,'role',t.role,
        'status',t.status,'attempt',t.attempt,'depends_on',COALESCE((
          SELECT jsonb_agg(dep_task.task_key ORDER BY dep_task.task_key)
          FROM workflow_dependencies d
          JOIN workflow_tasks dep_task ON dep_task.id=d.depends_on_task_id
          WHERE d.task_id=t.id
        ),'[]'::jsonb)
      ) ORDER BY t.task_key)
      FROM workflow_tasks t WHERE t.run_id=r.id
    ),'[]'::jsonb)
  )
  FROM agent_runs r
  JOIN requirement_specs s ON s.id=r.spec_id AND s.organization_id=r.organization_id
  WHERE r.organization_id=p_organization_id AND r.idempotency_key=p_idempotency_key
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION factory_create_run_bundle(
  p_id UUID,
  p_organization_id UUID,
  p_project_id UUID,
  p_created_by TEXT,
  p_idempotency_key TEXT,
  p_spec JSONB,
  p_tasks JSONB,
  p_created_at TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_spec_id UUID;
  v_run agent_runs%ROWTYPE;
  v_task JSONB;
  v_task_id UUID;
  v_dep TEXT;
  v_dep_id UUID;
BEGIN
  IF jsonb_typeof(p_tasks) <> 'array' OR jsonb_array_length(p_tasks) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'INVALID_TASK_GRAPH_SIZE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM factory_projects WHERE id=p_project_id AND organization_id=p_organization_id) THEN
    RAISE EXCEPTION 'PROJECT_NOT_FOUND';
  END IF;

  INSERT INTO requirement_specs(
    organization_id,project_id,version,title,description,target,
    acceptance_criteria,constraints,created_by
  )
  SELECT p_organization_id,p_project_id,
    COALESCE((SELECT max(version)+1 FROM requirement_specs WHERE project_id=p_project_id),1),
    p_spec->>'title',p_spec->>'description',p_spec->>'target',
    COALESCE(p_spec->'acceptanceCriteria','[]'::jsonb),
    COALESCE(p_spec->'constraints','[]'::jsonb),p_created_by
  RETURNING id INTO v_spec_id;

  INSERT INTO agent_runs(id,organization_id,project_id,spec_id,status,idempotency_key,created_by,created_at)
  VALUES(p_id,p_organization_id,p_project_id,v_spec_id,'queued',p_idempotency_key,p_created_by,p_created_at)
  RETURNING * INTO v_run;

  FOR v_task IN SELECT value FROM jsonb_array_elements(p_tasks) LOOP
    INSERT INTO workflow_tasks(organization_id,run_id,task_key,title,description,role,status,attempt)
    VALUES(p_organization_id,p_id,v_task->>'id',v_task->>'title',v_task->>'description',
      v_task->>'role',v_task->>'status',COALESCE((v_task->>'attempt')::integer,0))
    RETURNING id INTO v_task_id;
  END LOOP;

  FOR v_task IN SELECT value FROM jsonb_array_elements(p_tasks) LOOP
    FOR v_dep IN SELECT jsonb_array_elements_text(COALESCE(v_task->'dependsOn','[]'::jsonb)) LOOP
      SELECT id INTO v_task_id FROM workflow_tasks WHERE run_id=p_id AND task_key=v_task->>'id';
      SELECT id INTO v_dep_id FROM workflow_tasks WHERE run_id=p_id AND task_key=v_dep;
      IF v_dep_id IS NULL THEN RAISE EXCEPTION 'UNKNOWN_TASK_DEPENDENCY'; END IF;
      INSERT INTO workflow_dependencies(organization_id,run_id,task_id,depends_on_task_id)
      VALUES(p_organization_id,p_id,v_task_id,v_dep_id);
    END LOOP;
  END LOOP;

  INSERT INTO workflow_events(organization_id,run_id,event_type,event_key,payload)
  VALUES(p_organization_id,p_id,'run.created','run.created',jsonb_build_object('task_count',jsonb_array_length(p_tasks)));
  INSERT INTO audit_events(organization_id,actor_id,action,target_type,target_id,outcome,metadata)
  VALUES(p_organization_id,p_created_by,'run.create','run',p_id::text,'success',
    jsonb_build_object('project_id',p_project_id,'task_count',jsonb_array_length(p_tasks)));

  RETURN factory_get_run_by_idempotency(p_organization_id,p_idempotency_key);
EXCEPTION WHEN unique_violation THEN
  RETURN factory_get_run_by_idempotency(p_organization_id,p_idempotency_key);
END $$;

REVOKE ALL ON FUNCTION factory_create_project(UUID,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION factory_get_run_by_idempotency(UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION factory_create_run_bundle(UUID,UUID,UUID,TEXT,TEXT,JSONB,JSONB,TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION factory_create_project(UUID,TEXT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION factory_get_run_by_idempotency(UUID,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION factory_create_run_bundle(UUID,UUID,UUID,TEXT,TEXT,JSONB,JSONB,TIMESTAMPTZ) TO service_role;
