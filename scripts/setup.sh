#!/usr/bin/env bash
# One-time Cloudflare resource bootstrap for self-hosting this CRM.
#
# Idempotent: safe to re-run. Reuses anything that already exists (by
# name) instead of erroring, and only writes into wrangler.jsonc the
# fields that are still placeholders.
#
# Requires: `wrangler login` already done (checked below), Node + pnpm.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

WORKER_DIR="apps/worker"
WEB_DIR="apps/web"
WORKER_CONFIG="$WORKER_DIR/wrangler.jsonc"
WEB_CONFIG="$WEB_DIR/wrangler.jsonc"
DB_NAME="cell-phone-store-whatsapp-ai-db"
QUEUE_NAME="cell-phone-store-wa-broadcast-dispatch"
KV_BINDING="REPLY_CACHE"
MEDIA_KV_BINDING="MEDIA_STORE"
# Use project-specific Cloudflare namespace titles; bindings remain stable in code.
KV_NAMESPACE_NAME="cell-phone-store-reply-cache"
MEDIA_KV_NAMESPACE_NAME="cell-phone-store-media-store"

# Create wrangler.jsonc / .env.production from the templates if missing.
node scripts/config.mjs

# wrangler is a devDependency of apps/worker and apps/web, not the repo
# root, so every invocation below runs from inside apps/worker (never a
# bare `pnpm exec wrangler` at the repo root).
wrangler() { (cd "$WORKER_DIR" && pnpm exec wrangler "$@"); }

# Resolve KV IDs without grep -q pipelines (pipefail can abort on SIGPIPE).
kv_namespace_id() {
  local title="$1" output id attempt
  for attempt in 1 2 3 4 5; do
    output="$(wrangler kv namespace list --json 2>/dev/null || true)"
    id="$(printf '%s' "$output" | node -e "
      let s = '';
      process.stdin.on('data', (d) => { s += d; });
      process.stdin.on('end', () => {
        try {
          const parsed = JSON.parse(s);
          const list = Array.isArray(parsed) ? parsed : (parsed.result || []);
          const ns = list.find((n) => n.title === '$title');
          if (ns) console.log(ns.id);
        } catch {}
      });
    ")"
    if [ -n "$id" ]; then printf '%s' "$id"; return 0; fi
    sleep 2
  done
  return 1
}

echo "==> Checking Cloudflare auth..."
if ! wrangler whoami >/dev/null 2>&1; then
  echo "Not logged in. Run '(cd apps/worker && pnpm exec wrangler login)' first, then re-run this script." >&2
  exit 1
fi

# ── D1 database (shared by both Workers) ────────────────────────────────
echo "==> D1 database ($DB_NAME)..."
CURRENT_DB_ID=$(grep -A2 '"d1_databases"' "$WORKER_CONFIG" | grep -o '"database_id": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
if [ "$CURRENT_DB_ID" = "REPLACE_WITH_D1_DATABASE_ID" ] || [ -z "$CURRENT_DB_ID" ]; then
  EXISTING=$(wrangler d1 list 2>/dev/null | awk -v name="$DB_NAME" '$0 ~ name { for (i=1; i<=NF; i++) if ($i ~ /^[0-9a-fA-F-]{36}$/) { print $i; exit } }')

  if [ -n "${EXISTING:-}" ]; then
    DB_ID="$EXISTING"
    echo "    found existing database, id=$DB_ID"
  else
    OUTPUT=$(wrangler d1 create "$DB_NAME")
    DB_ID=$(printf '%s' "$OUTPUT" | grep -Eo '[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}' | head -1 || true)
    if [ -z "$DB_ID" ]; then
      echo "    ERROR: Could not read the new D1 database ID from Wrangler output." >&2
      exit 1
    fi
    echo "    created database, id=$DB_ID"
  fi

  node -e "
    const fs = require('fs');
    for (const path of ['$WORKER_CONFIG', '$WEB_CONFIG']) {
      let src = fs.readFileSync(path, 'utf8');
      src = src.replace(/\"database_id\": *\"[^\"]*\"/, '\"database_id\": \"$DB_ID\"');
      fs.writeFileSync(path, src);
    }
  "
else
  DB_ID="$CURRENT_DB_ID"
  echo "    already configured, id=$DB_ID"
fi

# ── Queue (safe-broadcast dispatch) ──────────────────────────────────────
echo "==> Queue ($QUEUE_NAME)..."
if wrangler queues list 2>/dev/null | grep -q "$QUEUE_NAME"; then
  echo "    already exists"
else
  wrangler queues create "$QUEUE_NAME"
fi

# ── KV namespace (AI agent reply cache) ──────────────────────────────────
echo "==> KV namespace ($KV_BINDING)..."
CURRENT_KV_ID=$(grep -A2 '"kv_namespaces"' "$WORKER_CONFIG" | grep -o '"id": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)
if [ "$CURRENT_KV_ID" = "REPLACE_WITH_KV_NAMESPACE_ID" ] || [ -z "$CURRENT_KV_ID" ]; then
  KV_ID="$(kv_namespace_id "$KV_NAMESPACE_NAME" || true)"
  if [ -z "$KV_ID" ]; then
    wrangler kv namespace create "$KV_NAMESPACE_NAME"
    echo "    created namespace"
    KV_ID="$(kv_namespace_id "$KV_NAMESPACE_NAME" || true)"
  else
    echo "    found existing namespace"
  fi
  if [ -n "$KV_ID" ]; then
    node -e "
      const fs = require('fs');
      let src = fs.readFileSync('$WORKER_CONFIG', 'utf8');
      src = src.replace(/(\"kv_namespaces\"[\s\S]*?\"id\": *)\"[^\"]*\"/, '\\$1\"$KV_ID\"');
      fs.writeFileSync('$WORKER_CONFIG', src);
    "
    echo "    wrote id into $WORKER_CONFIG"
  else
    echo "    ERROR: Cloudflare created/has the KV namespace but its ID could not be read. Check Workers KV read permission; no deployment attempted." >&2
    exit 1
  fi
else
  echo "    already configured, id=$CURRENT_KV_ID"
fi

# ── KV namespace (media storage) ────────────────────────────────────────
echo "==> KV namespace ($MEDIA_KV_BINDING)..."
MEDIA_KV_ID="$(kv_namespace_id "$MEDIA_KV_NAMESPACE_NAME" || true)"
if [ -z "$MEDIA_KV_ID" ]; then
  wrangler kv namespace create "$MEDIA_KV_NAMESPACE_NAME"
  echo "    created namespace"
  MEDIA_KV_ID="$(kv_namespace_id "$MEDIA_KV_NAMESPACE_NAME" || true)"
else
  echo "    found existing namespace"
fi
if [ -n "$MEDIA_KV_ID" ]; then
  node -e "
    const fs = require('fs');
    for (const path of ['$WORKER_CONFIG', '$WEB_CONFIG']) {
      let src = fs.readFileSync(path, 'utf8');
      src = src.replace(/(\"binding\": *\"MEDIA_STORE\", *\"id\": *)\"[^\"]*\"/, '\\$1\"$MEDIA_KV_ID\"');
      fs.writeFileSync(path, src);
    }
  "
  echo "    wrote id into both Worker and web configs"
else
  echo "    ERROR: Cloudflare media KV namespace ID could not be resolved; no deployment attempted." >&2
  exit 1
fi
# ── Run D1 migrations (remote) ───────────────────────────────────────────
echo "==> Applying D1 migrations..."
CI=true wrangler d1 migrations apply "$DB_NAME" --remote

# ── Auth secret ───────────────────────────────────────────────────────────
echo "==> Better Auth secret..."
if (cd "$WEB_DIR" && pnpm exec wrangler secret list 2>/dev/null | grep -q "BETTER_AUTH_SECRET"); then
  echo "    already set"
else
  GENERATED=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  (cd "$WEB_DIR" && echo "$GENERATED" | pnpm exec wrangler secret put BETTER_AUTH_SECRET)
  echo "    generated and set a new secret"
fi

# ── WebSocket token secret ────────────────────────────────────────────────
# Signs/verifies the short-lived token the browser presents when opening a
# WebSocket to the engine's /ws endpoint (GET /session/:id/ws-token mints
# it, apps/worker/src/session/whatsapp-session.ts verifies it). Must be the
# SAME value in both apps — generate it once here and set it in both.
echo "==> WebSocket token secret (WS_TOKEN_SECRET)..."
WEB_HAS_WS_SECRET=$(cd "$WEB_DIR" && pnpm exec wrangler secret list 2>/dev/null | grep -q "WS_TOKEN_SECRET" && echo yes || echo no)
WORKER_HAS_WS_SECRET=$(cd "$WORKER_DIR" && pnpm exec wrangler secret list 2>/dev/null | grep -q "WS_TOKEN_SECRET" && echo yes || echo no)
if [ "$WEB_HAS_WS_SECRET" = "yes" ] && [ "$WORKER_HAS_WS_SECRET" = "yes" ]; then
  echo "    already set in both apps"
else
  GENERATED=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  (cd "$WEB_DIR" && echo "$GENERATED" | pnpm exec wrangler secret put WS_TOKEN_SECRET)
  (cd "$WORKER_DIR" && echo "$GENERATED" | pnpm exec wrangler secret put WS_TOKEN_SECRET)
  echo "    generated and synchronized secret in both apps"
fi

# ── Engine internal secret (web -> engine auth) ──────────────────────────
echo "==> Engine internal secret (ENGINE_INTERNAL_SECRET)..."
WEB_HAS_ENGINE_SECRET=$(cd "$WEB_DIR" && pnpm exec wrangler secret list 2>/dev/null | grep -q "ENGINE_INTERNAL_SECRET" && echo yes || echo no)
WORKER_HAS_ENGINE_SECRET=$(cd "$WORKER_DIR" && pnpm exec wrangler secret list 2>/dev/null | grep -q "ENGINE_INTERNAL_SECRET" && echo yes || echo no)
if [ "$WEB_HAS_ENGINE_SECRET" = "yes" ] && [ "$WORKER_HAS_ENGINE_SECRET" = "yes" ]; then
  echo "    already set in both apps"
else
  GENERATED=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  (cd "$WEB_DIR" && echo "$GENERATED" | pnpm exec wrangler secret put ENGINE_INTERNAL_SECRET)
  (cd "$WORKER_DIR" && echo "$GENERATED" | pnpm exec wrangler secret put ENGINE_INTERNAL_SECRET)
  echo "    generated and synchronized secret in both apps"
fi

# ── Validate BETTER_AUTH_URL ──────────────────────────────────────────────
echo "==> Validating BETTER_AUTH_URL..."
AUTH_URL=$(grep -o '"BETTER_AUTH_URL": *"[^"]*"' "$WEB_CONFIG" | sed 's/.*"\([^"]*\)"$/\1/')
if [ "$AUTH_URL" = "http://localhost:3000" ]; then
  echo ""
  echo "  WARNING: BETTER_AUTH_URL is still set to http://localhost:3000" >&2
  echo "  Update it in $WEB_CONFIG to your production URL before deploying." >&2
  echo "  Example: \"BETTER_AUTH_URL\": \"https://app.yourdomain.com\"" >&2
  echo ""
fi

# ── Validate Resend from-email ────────────────────────────────────────────
echo "==> Validating RESEND_FROM_EMAIL..."
RESEND_FROM=$(grep -o '"RESEND_FROM_EMAIL": *"[^"]*"' "$WEB_CONFIG" | sed 's/.*"\([^"]*\)"$/\1/')
if [ "$RESEND_FROM" = "onboarding@resend.dev" ]; then
  echo ""
  echo "  WARNING: RESEND_FROM_EMAIL is still set to onboarding@resend.dev (sandbox mode)." >&2
  echo "  Invitation emails will fail silently in production." >&2
  echo "  Update it in $WEB_CONFIG to a domain you've verified with Resend." >&2
  echo ""
fi

echo ""
echo "Setup complete. Next: set your URLs (BETTER_AUTH_URL in $WEB_CONFIG, CORS_ORIGIN in $WORKER_CONFIG,"
echo "VITE_ENGINE_URL in both $WEB_CONFIG and $WEB_DIR/.env.production), then run 'pnpm deploy'."
