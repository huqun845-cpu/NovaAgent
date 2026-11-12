import { test } from "node:test";
import assert from "node:assert/strict";
import { PostgrestAIUsageLedger } from "../src/factory/ai-usage-ledger.ts";

test("reserves and settles a token budget through privileged RPCs", async () => {
  const calls = [];
  const ledger = new PostgrestAIUsageLedger({ url: "https://db.example.test", serviceKey: "server-only" }, async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  await ledger.reserve({ id: "11111111-1111-4111-8111-111111111111", organizationId: "22222222-2222-4222-8222-222222222222", userId: "user-1", feature: "requirement-planning", modelId: "provider/model", inputTokens: 100, outputTokens: 6000 });
  await ledger.settle("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", 75, 820);
  assert.match(calls[0].url, /factory_reserve_ai_budget$/);
  assert.equal(calls[0].body.p_output_tokens, 6000);
  assert.match(calls[1].url, /factory_settle_ai_invocation$/);
  assert.equal(calls[1].body.p_output_tokens, 820);
});
test("releases reservations after failed model attempts", async () => {
  let called = "";
  const ledger = new PostgrestAIUsageLedger({ url: "https://db.example.test", serviceKey: "server-only" }, async (url) => {
    called = String(url);
    return new Response(JSON.stringify({ status: "failed" }), { status: 200 });
  });
  await ledger.release("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "TIMEOUT");
  assert.match(called, /factory_release_ai_invocation$/);
});
test("fails closed when the organization budget is exhausted", async () => {
  const ledger = new PostgrestAIUsageLedger({ url: "https://db.example.test", serviceKey: "server-only" }, async () =>
    new Response("AI_BUDGET_EXCEEDED", { status: 400 }));
  await assert.rejects(() => ledger.reserve({ id: "11111111-1111-4111-8111-111111111111", organizationId: "22222222-2222-4222-8222-222222222222", userId: "user-1", feature: "planning", modelId: "provider/model", inputTokens: 1, outputTokens: 1 }), /AI_BUDGET_EXCEEDED/);
});
test("does not allow insecure database URLs", () => {
  assert.throws(() => new PostgrestAIUsageLedger({ url: "http://db.example.test", serviceKey: "secret" }), /INVALID_DATABASE_CONFIGURATION/);
});
