export interface AIInvocationReservation {
  id: string;
  organizationId: string;
  userId: string;
  feature: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}
export interface AIUsageLedger {
  reserve(input: AIInvocationReservation): Promise<void>;
  settle(id: string, organizationId: string, inputTokens: number, outputTokens: number): Promise<void>;
  release(id: string, organizationId: string, errorCode: string): Promise<void>;
}
export interface AIBudgetRepositoryConfig { url: string; serviceKey: string; }
export class PostgrestAIUsageLedger implements AIUsageLedger {
  private readonly base: string;
  constructor(private readonly config: AIBudgetRepositoryConfig, private readonly fetcher: typeof fetch = fetch) {
    this.base = config.url.replace(/\/$/, "");
    if (!/^https:\/\//.test(this.base) || !config.serviceKey) throw new Error("INVALID_DATABASE_CONFIGURATION");
  }
  private async rpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.fetcher(this.base + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: { apikey: this.config.serviceKey, authorization: "Bearer " + this.config.serviceKey,
        "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 240);
      const match = /AI_BUDGET_NOT_CONFIGURED|AI_BUDGET_EXCEEDED|AI_INVOCATION_NOT_FOUND/.exec(detail);
      throw new Error(match?.[0] ?? "AI_USAGE_LEDGER_FAILED:" + response.status);
    }
    return await response.json() as T;
  }
  async reserve(input: AIInvocationReservation): Promise<void> {
    await this.rpc("factory_reserve_ai_budget", {
      p_id: input.id, p_organization_id: input.organizationId, p_user_id: input.userId,
      p_feature: input.feature, p_model_id: input.modelId,
      p_input_tokens: input.inputTokens, p_output_tokens: input.outputTokens,
    });
  }
  async settle(id: string, organizationId: string, inputTokens: number, outputTokens: number): Promise<void> {
    await this.rpc("factory_settle_ai_invocation", {
      p_id: id, p_organization_id: organizationId, p_input_tokens: inputTokens, p_output_tokens: outputTokens,
    });
  }
  async release(id: string, organizationId: string, errorCode: string): Promise<void> {
    await this.rpc("factory_release_ai_invocation", {
      p_id: id, p_organization_id: organizationId, p_error_code: errorCode.slice(0, 80),
    });
  }
}
