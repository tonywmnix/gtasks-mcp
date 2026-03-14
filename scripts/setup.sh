#!/usr/bin/env bash
# setup.sh — one-shot setup for the gtasks-mcp-cf Cloudflare Worker
# Run this once before your first deployment.
set -euo pipefail

WRANGLER="npx wrangler"
TOML="wrangler.toml"

# ── helpers ──────────────────────────────────────────────────────────────────
red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

step() { echo; bold "▶ $*"; }

prompt_secret() {
  local name="$1" prompt="$2"
  printf '%s: ' "$prompt"
  # Try read -s (hides input), fall back to regular read
  if read -rs value 2>/dev/null; then
    echo
  else
    read -r value
  fi
  if [[ -z "$value" ]]; then
    red "  Value cannot be empty."
    exit 1
  fi
  echo "$value"
}

# ── preflight ────────────────────────────────────────────────────────────────
step "Checking prerequisites"
if ! command -v npx &>/dev/null; then
  red "npx not found. Install Node.js first: https://nodejs.org"
  exit 1
fi

bold "  Checking Wrangler login..."
if ! $WRANGLER whoami &>/dev/null; then
  yellow "  Not logged in. Opening browser for Wrangler login..."
  $WRANGLER login
fi
green "  Wrangler authenticated."

# ── KV namespace ─────────────────────────────────────────────────────────────
step "Creating KV namespace"

# Check if already created (wrangler.toml has a real ID)
EXISTING_ID=$(grep -E '^id\s*=' "$TOML" | head -1 | sed 's/.*=\s*"\(.*\)"/\1/' || true)
if [[ -n "$EXISTING_ID" && "$EXISTING_ID" != "REPLACE_WITH_YOUR_KV_NAMESPACE_ID" ]]; then
  yellow "  KV namespace already configured (id = $EXISTING_ID). Skipping creation."
else
  OUTPUT=$($WRANGLER kv namespace create OAUTH_KV 2>&1)
  echo "$OUTPUT"

  # Parse the ID from: id = "abc123..."
  KV_ID=$(echo "$OUTPUT" | grep -E '^\s*id\s*=' | sed 's/.*=\s*"\([^"]*\)".*/\1/' | tr -d '[:space:]')

  if [[ -z "$KV_ID" ]]; then
    red "  Could not parse KV namespace ID from wrangler output."
    red "  Copy the id from the output above and paste it into wrangler.toml manually."
    exit 1
  fi

  green "  KV namespace created: $KV_ID"

  # Patch wrangler.toml
  sed -i "s/REPLACE_WITH_YOUR_KV_NAMESPACE_ID/$KV_ID/" "$TOML"
  green "  wrangler.toml updated with KV namespace ID."
fi

# ── Worker URL ───────────────────────────────────────────────────────────────
step "Determining Worker URL"
ACCOUNT_SUBDOMAIN=$($WRANGLER whoami 2>&1 | grep -oE '[a-z0-9-]+\.workers\.dev' | head -1 || true)
if [[ -n "$ACCOUNT_SUBDOMAIN" ]]; then
  WORKER_URL="https://gtasks-mcp-cf.${ACCOUNT_SUBDOMAIN}"
  green "  Detected: $WORKER_URL"
else
  yellow "  Could not auto-detect your workers.dev subdomain."
  printf "  Enter your Worker URL (e.g. https://gtasks-mcp-cf.your-account.workers.dev): "
  read -r WORKER_URL
fi

# ── Google OAuth credentials ─────────────────────────────────────────────────
step "Google OAuth credentials"
echo
yellow "  You need a Google Cloud OAuth 2.0 Client ID and Secret."
yellow "  If you don't have one yet:"
yellow "    1. Go to https://console.cloud.google.com/apis/credentials"
yellow "    2. Create an OAuth 2.0 Client ID (type: Web application)"
yellow "    3. Add this Authorized Redirect URI:"
bold   "       ${WORKER_URL}/callback"
yellow "    4. Enable the Google Tasks API at:"
yellow "       https://console.cloud.google.com/apis/library/tasks.googleapis.com"
echo
printf "  Press Enter when ready..."
read -r

CLIENT_ID=$(prompt_secret GOOGLE_CLIENT_ID "  Google Client ID")
CLIENT_SECRET=$(prompt_secret GOOGLE_CLIENT_SECRET "  Google Client Secret")

# ── Set Wrangler secrets ─────────────────────────────────────────────────────
step "Setting Wrangler secrets"
echo "$CLIENT_ID"     | $WRANGLER secret put GOOGLE_CLIENT_ID
echo "$CLIENT_SECRET" | $WRANGLER secret put GOOGLE_CLIENT_SECRET
echo "$WORKER_URL"    | $WRANGLER secret put WORKER_URL
green "  Secrets set."

# ── Write .dev.vars for local development ────────────────────────────────────
step "Writing .dev.vars for local development"
cat > .dev.vars <<EOF
GOOGLE_CLIENT_ID=${CLIENT_ID}
GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}
WORKER_URL=http://localhost:8787
EOF
green "  .dev.vars written (gitignored)."
yellow "  Note: for local dev, also add http://localhost:8787/callback as an"
yellow "  Authorized Redirect URI in your Google Cloud Console OAuth client."

# ── Deploy ───────────────────────────────────────────────────────────────────
step "Deploying to Cloudflare Workers"
$WRANGLER deploy
echo
green "✅ Setup complete!"
bold  "   Your MCP server is live at: ${WORKER_URL}/mcp"
echo
yellow "  To add it to Claude, go to:"
yellow "    Settings → Integrations → Add MCP Server"
yellow "  and enter: ${WORKER_URL}/mcp"
echo
yellow "  To run locally: bun run worker:dev"
