import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { authenticateBearer } from "../src/factory/auth.ts";

const config = { secret: "test-secret-that-is-at-least-thirty-two-bytes-long", issuer: "https://auth.example.test", audience: "factory-api" };
function token(claimOverrides = {}, headerOverrides = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT", ...headerOverrides });
  const claims = encode({ sub: "user-1", org_id: "org-1", role: "admin", iss: config.issuer, aud: config.audience, exp: 2_000_000_000, ...claimOverrides });
  const signature = createHmac("sha256", config.secret).update(header + "." + claims).digest("base64url");
  return header + "." + claims + "." + signature;
}
const requestFor = value => new Request("https://factory.example.test/api/factory/projects", { headers: { authorization: "Bearer " + value } });

test("accepts a valid signed bearer token and derives the actor", async () => {
  const actor = await authenticateBearer(requestFor(token()), config, 1_900_000_000);
  assert.deepEqual(actor, { userId: "user-1", organizationId: "org-1", role: "admin" });
});
test("rejects missing or malformed bearer tokens", async () => {
  await assert.rejects(() => authenticateBearer(new Request("https://x"), config), /UNAUTHENTICATED/);
  await assert.rejects(() => authenticateBearer(requestFor("bad.token.value"), config), /INVALID_TOKEN/);
});
test("rejects bad signatures, expired tokens and incorrect issuer", async () => {
  const valid = token();
  await assert.rejects(() => authenticateBearer(requestFor(valid.slice(0, -1) + "x"), config, 1_900_000_000), /INVALID_TOKEN_SIGNATURE/);
  await assert.rejects(() => authenticateBearer(requestFor(token({ exp: 100 })), config, 101), /TOKEN_EXPIRED/);
  await assert.rejects(() => authenticateBearer(requestFor(token({ iss: "https://evil.test" })), config, 1_900_000_000), /INVALID_TOKEN_CLAIMS/);
});
test("rejects algorithm confusion and unrecognized roles", async () => {
  await assert.rejects(() => authenticateBearer(requestFor(token({}, { alg: "none" })), config), /INVALID_TOKEN_ALGORITHM/);
  await assert.rejects(() => authenticateBearer(requestFor(token({ role: "superuser" })), config), /INVALID_TOKEN_ROLE/);
});
