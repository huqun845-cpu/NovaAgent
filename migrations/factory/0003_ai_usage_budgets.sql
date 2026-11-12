-- Monthly organization-level token budgets and immutable AI invocation accounting.
-- Apply after 0002_control_plane_rpc.sql. Budget rows must be provisioned per organization.
CREATE TABLE factory_ai_budgets (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  monthly_input_token_limit BIGINT NOT NULL CHECK (monthly_input_token_limit > 0),
  monthly_output_token_limit BIGINT NOT NULL CHECK (monthly_output_token_limit > 0),
  period_start DATE NOT NULL DEFAULT date_trunc('month', now())::date,
  used_input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (used_input_tokens >= 0),
  used_output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (used_output_tokens >= 0),
  reserved_input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (reserved_input_tokens >= 0),
  reserved_output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (reserved_output_tokens >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE factory_ai_invocations (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id VARCHAR(160) NOT NULL,
  feature VARCHAR(80) NOT NULL,
  model_id VARCHAR(200) NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('reserved','succeeded','failed')),
  reserved_input_tokens BIGINT NOT NULL CHECK (reserved_input_tokens >= 0),
  reserved_output_tokens BIGINT NOT NULL CHECK (reserved_output_tokens >= 0),
  input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  error_code VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  UNIQUE (organization_id, id)
);
CREATE INDEX factory_ai_invocations_org_created ON factory_ai_invocations(organization_id, created_at DESC);
CREATE INDEX factory_ai_invocations_user_created ON factory_ai_invocations(organization_id, user_id, created_at DESC);

CREATE OR REPLACE FUNCTION factory_reserve_ai_budget(
  p_id UUID, p_organization_id UUID, p_user_id TEXT, p_feature TEXT, p_model_id TEXT,
  p_input_tokens BIGINT, p_output_tokens BIGINT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b factory_ai_budgets%ROWTYPE;
  v_period DATE := date_trunc('month', now())::date;
BEGIN
  IF p_input_tokens < 0 OR p_output_tokens < 0 OR p_input_tokens + p_output_tokens = 0 THEN RAISE EXCEPTION 'INVALID_AI_RESERVATION'; END IF;
  SELECT * INTO b FROM factory_ai_budgets WHERE organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_BUDGET_NOT_CONFIGURED'; END IF;
  IF b.period_start <> v_period THEN
    UPDATE factory_ai_budgets SET period_start=v_period, used_input_tokens=0, used_output_tokens=0,
      reserved_input_tokens=0, reserved_output_tokens=0, updated_at=now()
    WHERE organization_id=p_organization_id RETURNING * INTO b;
  END IF;
  IF b.used_input_tokens+b.reserved_input_tokens+p_input_tokens > b.monthly_input_token_limit
     OR b.used_output_tokens+b.reserved_output_tokens+p_output_tokens > b.monthly_output_token_limit THEN
    RAISE EXCEPTION 'AI_BUDGET_EXCEEDED';
  END IF;
  INSERT INTO factory_ai_invocations(id,organization_id,user_id,feature,model_id,status,reserved_input_tokens,reserved_output_tokens)
  VALUES(p_id,p_organization_id,p_user_id,p_feature,p_model_id,'reserved',p_input_tokens,p_output_tokens);
  UPDATE factory_ai_budgets SET reserved_input_tokens=reserved_input_tokens+p_input_tokens,
    reserved_output_tokens=reserved_output_tokens+p_output_tokens, updated_at=now()
  WHERE organization_id=p_organization_id;
  RETURN jsonb_build_object('invocation_id',p_id,'reserved_input_tokens',p_input_tokens,'reserved_output_tokens',p_output_tokens);
END $$;

CREATE OR REPLACE FUNCTION factory_settle_ai_invocation(
  p_id UUID, p_organization_id UUID, p_input_tokens BIGINT, p_output_tokens BIGINT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v factory_ai_invocations%ROWTYPE;
BEGIN
  IF p_input_tokens < 0 OR p_output_tokens < 0 THEN RAISE EXCEPTION 'INVALID_AI_USAGE'; END IF;
  SELECT * INTO v FROM factory_ai_invocations WHERE id=p_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_INVOCATION_NOT_FOUND'; END IF;
  IF v.status <> 'reserved' THEN RETURN jsonb_build_object('status',v.status,'idempotent',true); END IF;
  UPDATE factory_ai_budgets SET
    reserved_input_tokens=GREATEST(0,reserved_input_tokens-v.reserved_input_tokens),
    reserved_output_tokens=GREATEST(0,reserved_output_tokens-v.reserved_output_tokens),
    used_input_tokens=used_input_tokens+p_input_tokens,
    used_output_tokens=used_output_tokens+p_output_tokens, updated_at=now()
  WHERE organization_id=p_organization_id;
  UPDATE factory_ai_invocations SET status='succeeded',input_tokens=p_input_tokens,
    output_tokens=p_output_tokens,settled_at=now() WHERE id=p_id;
  RETURN jsonb_build_object('status','succeeded','input_tokens',p_input_tokens,'output_tokens',p_output_tokens);
END $$;

CREATE OR REPLACE FUNCTION factory_release_ai_invocation(
  p_id UUID, p_organization_id UUID, p_error_code TEXT DEFAULT 'MODEL_REQUEST_FAILED'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v factory_ai_invocations%ROWTYPE;
BEGIN
  SELECT * INTO v FROM factory_ai_invocations WHERE id=p_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_INVOCATION_NOT_FOUND'; END IF;
  IF v.status <> 'reserved' THEN RETURN jsonb_build_object('status',v.status,'idempotent',true); END IF;
  UPDATE factory_ai_budgets SET
    reserved_input_tokens=GREATEST(0,reserved_input_tokens-v.reserved_input_tokens),
    reserved_output_tokens=GREATEST(0,reserved_output_tokens-v.reserved_output_tokens), updated_at=now()
  WHERE organization_id=p_organization_id;
  UPDATE factory_ai_invocations SET status='failed',error_code=left(p_error_code,80),settled_at=now() WHERE id=p_id;
  RETURN jsonb_build_object('status','failed');
END $$;

REVOKE ALL ON FUNCTION factory_reserve_ai_budget(UUID,UUID,TEXT,TEXT,TEXT,BIGINT,BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION factory_settle_ai_invocation(UUID,UUID,BIGINT,BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION factory_release_ai_invocation(UUID,UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION factory_reserve_ai_budget(UUID,UUID,TEXT,TEXT,TEXT,BIGINT,BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION factory_settle_ai_invocation(UUID,UUID,BIGINT,BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION factory_release_ai_invocation(UUID,UUID,TEXT) TO service_role;
