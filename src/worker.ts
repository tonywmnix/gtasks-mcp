import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { google } from "googleapis";
import { createMcpServer } from "./server.js";

export interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  WORKER_URL: string; // e.g. https://gtasks-mcp.your-account.workers.dev
  OAUTH_KV: KVNamespace;
}

interface PkceFlow {
  code_challenge: string;
  code_challenge_method: string;
  redirect_uri: string;
  client_id: string;
  original_state: string;
}

interface AuthCodeData {
  google_access_token: string;
  google_refresh_token: string;
  token_expiry: number;
  code_challenge: string;
  redirect_uri: string;
  original_state: string;
}

interface McpTokenData {
  google_access_token: string;
  google_refresh_token: string;
  token_expiry: number;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
};

function withCors(response: Response): Response {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(CORS_HEADERS)) r.headers.set(k, v);
  return r;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function generateToken(length = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// ── OAuth 2.0 Authorization Server Metadata (RFC 8414) ──────────────────────

function handleMetadata(env: Env): Response {
  const base = env.WORKER_URL;
  return jsonResponse({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    scopes_supported: ["tasks"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
  });
}

// ── Dynamic Client Registration (RFC 7591) ───────────────────────────────────

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { redirect_uris?: string[] };
  const client_id = generateToken(16);
  await env.OAUTH_KV.put(
    `client:${client_id}`,
    JSON.stringify({ client_id, redirect_uris: body.redirect_uris ?? [] }),
    { expirationTtl: 60 * 60 * 24 * 365 },
  );
  return jsonResponse(
    { client_id, redirect_uris: body.redirect_uris ?? [] },
    201,
  );
}

// ── Authorization endpoint — redirects user to Google OAuth ──────────────────

async function handleAuthorize(
  request: Request,
  env: Env,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const client_id = params.get("client_id");
  const redirect_uri = params.get("redirect_uri");
  const code_challenge = params.get("code_challenge");
  const code_challenge_method = params.get("code_challenge_method") ?? "S256";
  const state = params.get("state") ?? "";

  if (
    !client_id ||
    !redirect_uri ||
    !code_challenge ||
    params.get("response_type") !== "code"
  ) {
    return new Response("Bad Request: missing required parameters", {
      status: 400,
    });
  }
  if (code_challenge_method !== "S256") {
    return new Response("Only S256 code_challenge_method is supported", {
      status: 400,
    });
  }

  // Store PKCE flow keyed by a random ID we pass as Google OAuth state
  const flow_id = generateToken(16);
  const flow: PkceFlow = {
    code_challenge,
    code_challenge_method,
    redirect_uri,
    client_id,
    original_state: state,
  };
  await env.OAUTH_KV.put(`pkce_flow:${flow_id}`, JSON.stringify(flow), {
    expirationTtl: 600, // 10 minutes
  });

  const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  googleUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  googleUrl.searchParams.set("redirect_uri", `${env.WORKER_URL}/callback`);
  googleUrl.searchParams.set("response_type", "code");
  googleUrl.searchParams.set(
    "scope",
    "https://www.googleapis.com/auth/tasks",
  );
  googleUrl.searchParams.set("access_type", "offline");
  googleUrl.searchParams.set("prompt", "consent"); // ensure refresh token is issued
  googleUrl.searchParams.set("state", flow_id);

  return Response.redirect(googleUrl.toString(), 302);
}

// ── Google OAuth callback ─────────────────────────────────────────────────────

async function handleCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const flow_id = params.get("state");
  const error = params.get("error");

  if (error) {
    return new Response(`Google OAuth error: ${error}`, { status: 400 });
  }
  if (!code || !flow_id) {
    return new Response("Bad Request", { status: 400 });
  }

  const flowJson = await env.OAUTH_KV.get(`pkce_flow:${flow_id}`);
  if (!flowJson) {
    return new Response("OAuth flow not found or expired", { status: 400 });
  }
  const flow: PkceFlow = JSON.parse(flowJson);
  await env.OAUTH_KV.delete(`pkce_flow:${flow_id}`);

  // Exchange Google auth code for Google tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${env.WORKER_URL}/callback`,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    return new Response(`Google token exchange failed: ${await tokenRes.text()}`, { status: 500 });
  }

  const googleTokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  // Issue an MCP auth code (short-lived, exchanged at /token)
  const mcp_auth_code = generateToken(32);
  const authCodeData: AuthCodeData = {
    google_access_token: googleTokens.access_token,
    google_refresh_token: googleTokens.refresh_token,
    token_expiry: Date.now() + googleTokens.expires_in * 1000,
    code_challenge: flow.code_challenge,
    redirect_uri: flow.redirect_uri,
    original_state: flow.original_state,
  };
  await env.OAUTH_KV.put(
    `auth_code:${mcp_auth_code}`,
    JSON.stringify(authCodeData),
    { expirationTtl: 600 },
  );

  // Redirect back to the MCP client with the auth code
  const redirectUrl = new URL(flow.redirect_uri);
  redirectUrl.searchParams.set("code", mcp_auth_code);
  if (flow.original_state) {
    redirectUrl.searchParams.set("state", flow.original_state);
  }
  return Response.redirect(redirectUrl.toString(), 302);
}

// ── Token endpoint — exchange MCP auth code for MCP access token ─────────────

async function handleToken(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("Content-Type") ?? "";
  let params: URLSearchParams;
  if (contentType.includes("application/x-www-form-urlencoded")) {
    params = new URLSearchParams(await request.text());
  } else {
    const body = (await request.json()) as Record<string, string>;
    params = new URLSearchParams(body);
  }

  const grant_type = params.get("grant_type");
  const code = params.get("code");
  const code_verifier = params.get("code_verifier");
  const redirect_uri = params.get("redirect_uri");

  if (grant_type !== "authorization_code" || !code || !code_verifier) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }

  const authCodeJson = await env.OAUTH_KV.get(`auth_code:${code}`);
  if (!authCodeJson) {
    return jsonResponse(
      { error: "invalid_grant", error_description: "Code not found or expired" },
      400,
    );
  }
  const authCodeData: AuthCodeData = JSON.parse(authCodeJson);
  await env.OAUTH_KV.delete(`auth_code:${code}`);

  if (redirect_uri && redirect_uri !== authCodeData.redirect_uri) {
    return jsonResponse(
      { error: "invalid_grant", error_description: "redirect_uri mismatch" },
      400,
    );
  }

  // Verify PKCE: SHA256(code_verifier) must match stored code_challenge
  const expected = await sha256Base64Url(code_verifier);
  if (expected !== authCodeData.code_challenge) {
    return jsonResponse(
      { error: "invalid_grant", error_description: "PKCE verification failed" },
      400,
    );
  }

  // Issue a long-lived MCP access token
  const mcp_token = generateToken(32);
  const tokenData: McpTokenData = {
    google_access_token: authCodeData.google_access_token,
    google_refresh_token: authCodeData.google_refresh_token,
    token_expiry: authCodeData.token_expiry,
  };
  await env.OAUTH_KV.put(
    `mcp_token:${mcp_token}`,
    JSON.stringify(tokenData),
    { expirationTtl: 60 * 60 * 24 * 30 }, // 30 days
  );

  return jsonResponse({
    access_token: mcp_token,
    token_type: "bearer",
    expires_in: 60 * 60 * 24 * 30,
  });
}

// ── Token refresh helper ──────────────────────────────────────────────────────

async function getValidGoogleToken(
  env: Env,
  tokenData: McpTokenData,
): Promise<{ access_token: string; updated?: McpTokenData }> {
  // Use cached token if it has more than 5 minutes remaining
  if (tokenData.token_expiry && Date.now() < tokenData.token_expiry - 5 * 60 * 1000) {
    return { access_token: tokenData.google_access_token };
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tokenData.google_refresh_token,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new Error(`Google token refresh failed: ${await res.text()}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  const updated: McpTokenData = {
    ...tokenData,
    google_access_token: data.access_token,
    token_expiry: Date.now() + data.expires_in * 1000,
  };
  return { access_token: data.access_token, updated };
}

// ── MCP endpoint — requires valid Bearer token ───────────────────────────────

async function handleMcp(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse(
      { error: "unauthorized", error_description: "Missing Bearer token" },
      401,
    );
  }

  const mcp_token = authHeader.slice(7);
  const tokenJson = await env.OAUTH_KV.get(`mcp_token:${mcp_token}`);
  if (!tokenJson) {
    return jsonResponse(
      { error: "unauthorized", error_description: "Invalid or expired token" },
      401,
    );
  }

  let tokenData: McpTokenData = JSON.parse(tokenJson);
  let access_token: string;
  try {
    const result = await getValidGoogleToken(env, tokenData);
    access_token = result.access_token;
    if (result.updated) {
      tokenData = result.updated;
      await env.OAUTH_KV.put(
        `mcp_token:${mcp_token}`,
        JSON.stringify(tokenData),
        { expirationTtl: 60 * 60 * 24 * 30 },
      );
    }
  } catch {
    return jsonResponse(
      { error: "unauthorized", error_description: "Token refresh failed" },
      401,
    );
  }

  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token });
  const tasksClient = google.tasks({ version: "v1", auth });

  const server = createMcpServer(tasksClient);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless per-request mode
  });
  await server.connect(transport);

  return transport.handleRequest(request);
}

// ── Main fetch handler ────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const { pathname } = new URL(request.url);

    if (pathname === "/.well-known/oauth-authorization-server") {
      return withCors(handleMetadata(env));
    }
    if (pathname === "/register" && request.method === "POST") {
      return withCors(await handleRegister(request, env));
    }
    if (pathname === "/authorize" && request.method === "GET") {
      return handleAuthorize(request, env);
    }
    if (pathname === "/callback" && request.method === "GET") {
      return handleCallback(request, env);
    }
    if (pathname === "/token" && request.method === "POST") {
      return withCors(await handleToken(request, env));
    }
    if (pathname === "/mcp") {
      return withCors(await handleMcp(request, env));
    }

    return new Response("Not Found", { status: 404 });
  },
};
