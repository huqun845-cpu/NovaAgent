import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Factory API is dispatched before Telegram credentials and D1 schema initialization", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const fetchStart = source.indexOf("async fetch(request: Request, env: Env, ctx: ExecutionContext)");
  assert.notEqual(fetchStart, -1);
  const route = source.indexOf('if (url.pathname.startsWith("/api/factory/"))', fetchStart);
  const telegramGuard = source.indexOf("if (!env.TOKEN || !env.DB)", fetchStart);
  const d1Schema = source.indexOf("await ensureCoreSchema(env)", fetchStart);
  assert.ok(route > fetchStart && route < telegramGuard, "Factory must not require Telegram token or D1");
  assert.ok(route < d1Schema, "Factory must not wait for Telegram D1 schema setup");
});
