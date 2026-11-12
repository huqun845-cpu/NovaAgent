import { validateRequirementSpec } from "./domain";
import { AIGatewayRequirementPlanner } from "./ai-planner";

export interface FactoryPlanningEnv {
  FACTORY_PLANNER_MODEL: string;
  FACTORY_PLANNER_FALLBACK_MODEL?: string;
  AI_GATEWAY_API_KEY?: string;
}
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
});
export async function handleFactoryPlanningRequest(request: Request, env: FactoryPlanningEnv): Promise<Response> {
  if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > 64 * 1024) return json({ error: "REQUEST_TOO_LARGE" }, 413);
  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 64 * 1024) return json({ error: "REQUEST_TOO_LARGE" }, 413);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ error: "INVALID_JSON" }, 400);
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "INVALID_JSON" }, 400);
  }
  try {
    const spec = validateRequirementSpec(body.spec);
    const planner = new AIGatewayRequirementPlanner({
      primaryModel: env.FACTORY_PLANNER_MODEL,
      fallbackModel: env.FACTORY_PLANNER_FALLBACK_MODEL,
      gatewayApiKey: env.AI_GATEWAY_API_KEY,
    });
    const plan = await planner.plan(spec);
    return json({ plan }, 200);
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":")[0] : "INTERNAL_ERROR";
    const status = code.startsWith("INVALID_") ? 400 : code === "PLANNER_MODEL_REQUIRED" ? 503 : 502;
    return json({ error: status === 502 ? "AI_PLANNING_FAILED" : code }, status);
  }
}
