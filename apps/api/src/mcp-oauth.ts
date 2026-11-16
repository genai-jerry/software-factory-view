/**
 * Sign-in for MCP servers that use OAuth instead of an API key (Fathom, and
 * any server following the MCP authorization spec).
 *
 * Discovery follows the spec: the server answers 401 with a
 * `WWW-Authenticate: Bearer resource_metadata="…"` header (or serves
 * /.well-known/oauth-protected-resource), which names its authorization
 * server; that server's /.well-known/oauth-authorization-server gives the
 * endpoints. Compass registers itself as a public client (dynamic client
 * registration, RFC 7591), sends the person's browser to the authorization
 * endpoint with PKCE (S256), and swaps the code for tokens at the token
 * endpoint. Refresh tokens keep the sign-in alive without the person.
 *
 * Every request Compass makes itself goes through the same public-address
 * check as listing tools: no private ranges, no redirects. The authorization
 * endpoint is only ever opened by the person's browser.
 */

import { createHash, randomBytes } from "node:crypto";
import { checkReachable, type Reach } from "./mcp-client.js";

export interface ServerAuthMeta {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  /** The resource the token is for (RFC 8707): the MCP server's own URL. */
  resource: string;
  scope: string | null;
}

/** What Compass keeps, sealed, for one signed-in server. */
export interface OAuthGrant {
  clientId: string;
  clientSecret: string | null;
  tokenEndpoint: string;
  resource: string;
  scope: string | null;
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms; null when the server did not say. */
  expiresAt: number | null;
}

export class OAuthFailure extends Error {}

const TIMEOUT_MS = 15_000;

async function fetchPublic(url: string, init: RequestInit, reach: Reach): Promise<Response> {
  const refused = await checkReachable(url, reach);
  if (refused) throw new OAuthFailure(refused);
  const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status >= 300 && res.status < 400) throw new OAuthFailure(`${new URL(url).host} redirected instead of answering`);
  return res;
}

async function getJson(url: string, reach: Reach): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchPublic(url, { headers: { accept: "application/json" } }, reach);
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch (err) {
    if (err instanceof OAuthFailure) throw err;
    return null;
  }
}

/** The resource_metadata URL from a `WWW-Authenticate: Bearer …` header, if any. */
export function resourceMetadataUrl(header: string | null): string | null {
  const m = /resource_metadata="([^"]+)"/i.exec(header ?? "");
  return m ? m[1]! : null;
}

function https(raw: unknown, what: string, reach: Reach): string {
  if (typeof raw !== "string") throw new OAuthFailure(`the server's sign-in details have no ${what}`);
  const u = new URL(raw);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(reach.allowLocal && local)) throw new OAuthFailure(`the server's ${what} is not https`);
  return u.toString();
}

/** Ask an MCP server how to sign in to it. */
export async function discover(serverUrl: string, transport: "http" | "sse", reach: Reach = {}): Promise<ServerAuthMeta> {
  const server = new URL(serverUrl);
  // 1. The server's own 401 names its metadata.
  let named: string | null = null;
  try {
    const res =
      transport === "sse"
        ? await fetchPublic(serverUrl, { method: "GET", headers: { accept: "text/event-stream" } }, reach)
        : await fetchPublic(
            serverUrl,
            {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "compass", version: "1" } } }),
            },
            reach,
          );
    if (res.status !== 401 && res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new OAuthFailure("the server answered without asking anyone to sign in — add it with Add server instead");
    }
    named = resourceMetadataUrl(res.headers.get("www-authenticate"));
    await res.body?.cancel().catch(() => undefined);
  } catch (err) {
    if (err instanceof OAuthFailure) throw err;
    throw new OAuthFailure(`could not reach the server (${(err as Error).message})`);
  }

  // 2. Protected-resource metadata: named, or at the well-known places.
  const path = server.pathname.replace(/\/$/, "");
  const prmCandidates = [named, `${server.origin}/.well-known/oauth-protected-resource${path}`, `${server.origin}/.well-known/oauth-protected-resource`].filter(
    (u): u is string => Boolean(u),
  );
  let prm: Record<string, unknown> | null = null;
  for (const u of prmCandidates) if ((prm = await getJson(u, reach))) break;

  // 3. Authorization-server metadata.
  const issuer = new URL(Array.isArray(prm?.authorization_servers) && typeof prm.authorization_servers[0] === "string" ? prm.authorization_servers[0] : server.origin);
  const ipath = issuer.pathname.replace(/\/$/, "");
  const asCandidates = [
    `${issuer.origin}/.well-known/oauth-authorization-server${ipath}`,
    `${issuer.origin}/.well-known/openid-configuration${ipath}`,
    ...(ipath ? [`${issuer.origin}${ipath}/.well-known/openid-configuration`] : []),
  ];
  let meta: Record<string, unknown> | null = null;
  for (const u of asCandidates) if ((meta = await getJson(u, reach))) break;
  if (!meta) throw new OAuthFailure("the server asks for a sign-in but does not publish how (no OAuth metadata)");

  const methods = meta.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) throw new OAuthFailure("the server's sign-in does not support PKCE (S256)");
  const scopes = Array.isArray(prm?.scopes_supported) ? (prm.scopes_supported as unknown[]).filter((s): s is string => typeof s === "string") : [];
  return {
    authorizationEndpoint: https(meta.authorization_endpoint, "authorization endpoint", reach),
    tokenEndpoint: https(meta.token_endpoint, "token endpoint", reach),
    registrationEndpoint: typeof meta.registration_endpoint === "string" ? https(meta.registration_endpoint, "registration endpoint", reach) : null,
    resource: typeof prm?.resource === "string" ? prm.resource : serverUrl,
    scope: scopes.length ? scopes.join(" ") : null,
  };
}

/** Register Compass as a public client of the server's authorization server. */
export async function register(meta: ServerAuthMeta, redirectUri: string, reach: Reach = {}): Promise<{ clientId: string; clientSecret: string | null }> {
  if (!meta.registrationEndpoint) {
    throw new OAuthFailure("the server does not let apps register themselves, so Compass cannot sign in to it yet");
  }
  const res = await fetchPublic(
    meta.registrationEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "Compass",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(meta.scope ? { scope: meta.scope } : {}),
      }),
    },
    reach,
  );
  const body = (await res.json().catch(() => null)) as { client_id?: unknown; client_secret?: unknown; error_description?: unknown } | null;
  if (!res.ok || typeof body?.client_id !== "string") {
    throw new OAuthFailure(`the server would not register Compass (${res.status}${typeof body?.error_description === "string" ? `: ${body.error_description}` : ""})`);
  }
  return { clientId: body.client_id, clientSecret: typeof body.client_secret === "string" ? body.client_secret : null };
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizeUrl(meta: ServerAuthMeta, clientId: string, redirectUri: string, state: string, challenge: string): string {
  const u = new URL(meta.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("resource", meta.resource);
  if (meta.scope) u.searchParams.set("scope", meta.scope);
  return u.toString();
}

async function tokenCall(
  base: Pick<OAuthGrant, "clientId" | "clientSecret" | "tokenEndpoint" | "resource" | "scope">,
  params: Record<string, string>,
  reach: Reach,
  previousRefresh: string | null,
): Promise<OAuthGrant> {
  const form = new URLSearchParams({ ...params, client_id: base.clientId, resource: base.resource });
  if (base.clientSecret) form.set("client_secret", base.clientSecret);
  const res = await fetchPublic(
    base.tokenEndpoint,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form.toString() },
    reach,
  );
  const body = (await res.json().catch(() => null)) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    error?: unknown;
    error_description?: unknown;
  } | null;
  if (!res.ok || typeof body?.access_token !== "string") {
    const why = typeof body?.error_description === "string" ? body.error_description : typeof body?.error === "string" ? body.error : String(res.status);
    throw new OAuthFailure(`the server refused the sign-in (${why})`);
  }
  return {
    ...base,
    scope: typeof body.scope === "string" ? body.scope : base.scope,
    accessToken: body.access_token,
    // A server that does not rotate refresh tokens keeps the old one valid.
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : previousRefresh,
    expiresAt: typeof body.expires_in === "number" && body.expires_in > 0 ? Date.now() + body.expires_in * 1000 : null,
  };
}

export function exchangeCode(
  base: Pick<OAuthGrant, "clientId" | "clientSecret" | "tokenEndpoint" | "resource" | "scope">,
  code: string,
  verifier: string,
  redirectUri: string,
  reach: Reach = {},
): Promise<OAuthGrant> {
  return tokenCall(base, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }, reach, null);
}

export function refreshGrant(grant: OAuthGrant, reach: Reach = {}): Promise<OAuthGrant> {
  if (!grant.refreshToken) return Promise.reject(new OAuthFailure("the server gave no refresh token, so the sign-in cannot renew itself"));
  return tokenCall(grant, { grant_type: "refresh_token", refresh_token: grant.refreshToken }, reach, grant.refreshToken);
}
