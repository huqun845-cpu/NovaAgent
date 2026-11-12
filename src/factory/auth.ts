import type { FactoryActor } from "./service";
import type { FactoryRole } from "./domain";

export interface FactoryAuthConfig {
  secret: string;
  issuer: string;
  audience: string;
}
interface JwtClaims {
  sub?: string; org_id?: string; role?: string; iss?: string; aud?: string;
  exp?: number; nbf?: number; iat?: number;
}
function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}
function parsePart(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_TOKEN");
  return parsed as Record<string, unknown>;
}

/** Verifies HS256 tokens with WebCrypto; never trusts unsigned identity headers. */
export async function authenticateBearer(request: Request, config: FactoryAuthConfig, nowSeconds = Math.floor(Date.now() / 1000)): Promise<FactoryActor> {
  if (!config.secret || config.secret.length < 32) throw new Error("AUTH_NOT_CONFIGURED");
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
  if (!match) throw new Error("UNAUTHENTICATED");
  const parts = match[1].split(".");
  if (parts.length !== 3) throw new Error("INVALID_TOKEN");
  const protectedHeader = parsePart(parts[0]);
  const claims = parsePart(parts[1]) as JwtClaims;
  if (protectedHeader.alg !== "HS256" || protectedHeader.typ !== "JWT") throw new Error("INVALID_TOKEN_ALGORITHM");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(config.secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", key, decodeBase64Url(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!valid) throw new Error("INVALID_TOKEN_SIGNATURE");
  if (claims.iss !== config.issuer || claims.aud !== config.audience) throw new Error("INVALID_TOKEN_CLAIMS");
  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) throw new Error("TOKEN_EXPIRED");
  if (typeof claims.nbf === "number" && claims.nbf > nowSeconds) throw new Error("TOKEN_NOT_ACTIVE");
  if (typeof claims.sub !== "string" || !claims.sub || typeof claims.org_id !== "string" || !claims.org_id) throw new Error("INVALID_TOKEN_IDENTITY");
  const roles: FactoryRole[] = ["owner", "admin", "architect", "engineer", "qa", "reviewer", "viewer"];
  if (!roles.includes(claims.role as FactoryRole)) throw new Error("INVALID_TOKEN_ROLE");
  return { userId: claims.sub, organizationId: claims.org_id, role: claims.role as FactoryRole };
}
