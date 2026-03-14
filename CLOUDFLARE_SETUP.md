# Cloudflare Worker + Google Cloud Setup Guide

This guide covers deploying the Google Tasks MCP server as a Cloudflare Worker with full OAuth 2.0 support (no hardcoded tokens).

---

## Architecture Overview

```
MCP Client (e.g. claude.ai)
    │
    ├─ GET /.well-known/oauth-protected-resource   ← RFC 9728 discovery
    ├─ GET /.well-known/oauth-authorization-server ← RFC 8414 metadata
    ├─ POST /register                              ← Dynamic client registration
    ├─ GET  /authorize  →  Google OAuth consent    ← PKCE flow start
    ├─ GET  /callback   ←  Google redirects back   ← Token exchange
    ├─ POST /token                                 ← Issue MCP access token
    └─ POST /mcp                                   ← Authenticated MCP requests
```

Tokens and OAuth state are stored in a **Cloudflare KV namespace**. Google tokens are refreshed automatically on each MCP request.

---

## Part 1: Google Cloud Console

### 1.1 Create or select a project

Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project or select an existing one.

> **Note:** The Tasks API and OAuth credentials must be in the same project.

### 1.2 Enable the Google Tasks API

1. Navigate to **APIs & Services → Library**
2. Search for "Google Tasks API"
3. Click **Enable**

### 1.3 Configure the OAuth consent screen

1. Navigate to **APIs & Services → OAuth consent screen**
2. Choose **External** (or Internal if using Google Workspace)
3. Fill in the required fields:
   - App name (e.g. `gtasks-mcp`)
   - User support email
   - Developer contact email
4. On the **Scopes** step, add:
   ```
   https://www.googleapis.com/auth/tasks
   ```
5. On the **Test users** step, add your Gmail address (required while the app is in "Testing" mode)
6. Save and continue

### 1.4 Create OAuth credentials

1. Navigate to **APIs & Services → Credentials**
2. Click **Create Credentials → OAuth client ID**
3. Application type: **Web application**
4. Add an authorized redirect URI:
   ```
   https://<your-worker-name>.<your-account>.workers.dev/callback
   ```
   Example:
   ```
   https://gtasks-mcp-cf.tonywmnix.workers.dev/callback
   ```
5. Click **Create**
6. Copy the **Client ID** and **Client Secret** — you will need these for the Cloudflare secrets step

---

## Part 2: Cloudflare

### 2.1 Create a KV namespace

```bash
wrangler kv namespace create OAUTH_KV
```

Copy the `id` from the output.

### 2.2 Configure wrangler.toml

```toml
name = "gtasks-mcp-cf"
main = "src/worker.ts"
compatibility_date = "2024-11-01"
compatibility_flags = ["nodejs_compat"]

[[kv_namespaces]]
binding = "OAUTH_KV"
id = "<your-kv-namespace-id>"

[vars]
WORKER_URL = "https://gtasks-mcp-cf.<your-account>.workers.dev"
```

> **Critical:** `WORKER_URL` must be the base URL with **no trailing slash** and **no path suffix**. Getting this wrong breaks all OAuth metadata endpoints.

### 2.3 Set secrets

```bash
wrangler secret put GOOGLE_CLIENT_ID
# paste your OAuth Client ID when prompted

wrangler secret put GOOGLE_CLIENT_SECRET
# paste your OAuth Client Secret when prompted
```

Secrets are encrypted and never stored in `wrangler.toml`.

### 2.4 Deploy

```bash
wrangler deploy
```

If your repo is connected to Cloudflare via GitHub integration, pushing to `main` triggers automatic deployment.

### 2.5 Verify deployment

```bash
curl https://<your-worker>.workers.dev/.well-known/oauth-protected-resource
```

Expected response:
```json
{
  "resource": "https://...",
  "authorization_servers": ["https://..."],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["tasks"]
}
```

### 2.6 Connect to an MCP client

In Claude Code:
```bash
claude mcp add gtasks https://<your-worker>.workers.dev/mcp
```

In `claude.ai`, add the URL as a remote MCP server. The OAuth flow will trigger automatically on first use.

---

## Troubleshooting

### Worker returns 302 to `cloudflareaccess.com`

**Symptom:** All requests redirect to `https://<your-team>.cloudflareaccess.com/cdn-cgi/access/login/...`

**Cause:** Cloudflare Zero Trust / Access is protecting the worker.

**Fix:** In the Cloudflare dashboard, go to **Zero Trust → Access → Applications**, find the application covering your worker URL, and either delete it or add a bypass policy for the worker's routes.

---

### OAuth discovery fails / MCP client can't start auth flow

**Symptom:** The MCP client shows an auth error immediately without opening a browser window.

**Cause:** The `/.well-known/oauth-protected-resource` endpoint is missing or returning an error.

**Fix:** Verify the endpoint returns valid JSON:
```bash
curl -v https://<your-worker>.workers.dev/.well-known/oauth-protected-resource
```
If you get a 404, the worker may not be deployed or the route handler is missing.

---

### 401 responses with no `WWW-Authenticate` header

**Symptom:** MCP client receives a 401 but doesn't know where to authenticate.

**Cause:** The `WWW-Authenticate` header is missing from 401 responses at `/mcp`.

**Fix:** Ensure your `/mcp` handler returns:
```
WWW-Authenticate: Bearer realm="<WORKER_URL>", resource_metadata="<WORKER_URL>/.well-known/oauth-protected-resource"
```

---

### `WORKER_URL` has `/callback` or other path suffix

**Symptom:** OAuth metadata endpoints return wrong URLs (e.g. `authorization_endpoint` contains `/callback/authorize`).

**Cause:** The Cloudflare dashboard may have set `WORKER_URL` as an environment variable (not a secret) with a wrong value. Dashboard-set vars override `wrangler.toml` vars.

**Fix:**
1. In the Cloudflare dashboard, go to **Workers → your worker → Settings → Variables**
2. Delete any `WORKER_URL` environment variable set there
3. Re-deploy with `wrangler deploy` so the value from `wrangler.toml` is used

---

### Secrets not taking effect / error 10053

**Symptom:** `wrangler secret put` fails with error 10053 (binding name conflict), or secrets appear unset after deployment.

**Cause:** The Cloudflare dashboard had `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set as plain environment variables (not secrets), conflicting with the secret binding.

**Fix:**
1. Go to **Workers → your worker → Settings → Variables**
2. Delete `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from the **Environment Variables** section (not the Secrets section)
3. Run `wrangler secret put GOOGLE_CLIENT_ID` and `wrangler secret put GOOGLE_CLIENT_SECRET` again
4. Re-deploy

---

### Wrong worker name creates a new accidental worker

**Symptom:** Deploying creates a new worker (e.g. `gtasks-mcp`) instead of updating the existing one (`gtasks-mcp-cf`).

**Cause:** `name` in `wrangler.toml` doesn't match the deployed worker name.

**Fix:** Make sure `name` in `wrangler.toml` exactly matches the worker name shown in the Cloudflare dashboard.

---

### Google token refresh fails at runtime

**Symptom:** MCP requests return `{"error":"unauthorized","error_description":"Token refresh failed"}` after the initial token expires (~1 hour).

**Cause:** Google did not issue a refresh token during the OAuth flow, or the refresh token was revoked.

**Fix:**
- Ensure the OAuth consent screen is configured and the user is listed as a test user (if the app is in Testing mode)
- The `/authorize` endpoint must include `access_type=offline` and `prompt=consent` — both are set in the current implementation
- If the user previously authorized the app without `prompt=consent`, they may need to revoke access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and re-authorize

---

### Node.js / npm from Windows running in WSL

**Symptom:** npm commands fail with `EPERM` errors or behave unexpectedly in WSL.

**Cause:** The `node` and `npm` binaries resolve to the Windows installation instead of a Linux one.

**Fix:** Install Node.js via nvm inside WSL:
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.bashrc
nvm install --lts
```
Then use the nvm-managed node/npx for all wrangler commands.
