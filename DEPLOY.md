# Deploying the zero-cost profile

This branch is adapted for a strict **$0/month** budget. Read [FREE_PLAN.md](./FREE_PLAN.md) before deployment. Do not follow older instructions that mention R2, Vectorize, AI Gateway, or Cloudflare's paid Rate Limiting API.

The application uses two Cloudflare Workers (`apps/worker`, the WhatsApp engine; `apps/web`, the CRM) sharing one D1 database.

## Prerequisites

- A Cloudflare account kept on the **Workers Free** plan.
- Node 22+ and pnpm (the repository pins its pnpm version).
- Wrangler login: `pnpm exec wrangler login`.
- A GitHub account for the fork and draft pull request.

Do not add a payment method, enable Workers Paid, or subscribe to R2 for this profile.

## Resources created by setup

`pnpm setup` runs `scripts/setup.sh`. It creates or reuses:

1. **D1** database `whatsapp-ai`.
2. **Queues** queue `wa-broadcast-dispatch` for the existing broadcast workflow.
3. **KV** namespace `REPLY_CACHE` for answer/config caching.
4. **KV** namespace `MEDIA_STORE` for bounded media storage.
5. D1 migrations and required application secrets.
6. Durable Object classes are registered through Wrangler migrations when the engine is deployed.

It does **not** create R2 buckets, Vectorize indexes, AI Gateway resources, or paid Rate Limiting API bindings.

## Configuration

Local deployment files are gitignored and copied from their tracked templates by `pnpm install`:

| Template | Local file |
| --- | --- |
| `apps/web/wrangler.example.jsonc` | `apps/web/wrangler.jsonc` |
| `apps/worker/wrangler.example.jsonc` | `apps/worker/wrangler.jsonc` |
| `apps/web/.env.production.example` | `apps/web/.env.production` |

`pnpm setup` writes the D1 id and both KV namespace ids into the worker configuration. Set the real app and engine URLs and make sure `BETTER_AUTH_URL`, `CORS_ORIGIN`, and `VITE_ENGINE_URL` match.

Local configuration backup is available without Cloudflare storage:

```bash
pnpm config:backup
pnpm config:restore
```

Do not use `pnpm config:backup --cloud` or `pnpm config:restore --cloud` in this zero-cost profile; those optional legacy commands use R2.

## GitHub Actions

The CI workflow runs lint, typecheck, tests, build, and Baileys patch checks on pull requests to `main`. Deployment is restricted to a push to `main`; a draft pull request does not deploy.

For a later CI deployment, configure these repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `D1_DATABASE_ID`
- `KV_NAMESPACE_ID` (the `REPLY_CACHE` namespace)
- `MEDIA_KV_NAMESPACE_ID` (the `MEDIA_STORE` namespace)

And these repository variables:

- `APP_URL` (CRM origin)
- `ENGINE_URL` (engine Worker URL)
- `SENTRY_DSN` (optional)

The scheduled R2 backup workflow is intentionally removed. D1 Free provides a 7-day Time Travel recovery window, not a separate encrypted export. Keep any important export outside Cloudflare and protect it appropriately.

## Manual setup reference

From the repository root, after login:

```bash
cd apps/worker
wrangler d1 create whatsapp-ai
wrangler queues create wa-broadcast-dispatch
wrangler kv namespace create REPLY_CACHE
wrangler kv namespace create MEDIA_STORE
# Put the returned D1/KV ids into the matching wrangler.jsonc templates.
wrangler d1 migrations apply whatsapp-ai --remote --migrations-dir ../../packages/db/migrations
```

Then deploy the engine first and the web app second:

```bash
pnpm build
(cd apps/worker && pnpm exec wrangler deploy)
(cd apps/web && pnpm exec wrangler deploy)
```

The normal `pnpm setup` and `pnpm deploy` scripts perform these steps; the manual commands are only a reference.

## Free-plan behavior to expect

- Message search and agent knowledge retrieval use workspace-scoped D1 text matching, not semantic embeddings.
- Media larger than 24 MiB is not retained in the CRM. If KV reaches its daily write allowance, messages remain but attachment storage can fail.
- Workers AI is called directly. When its daily Free neuron allowance is exhausted, the agent sends a safe fixed response instead of guessing.
- A human outgoing message pauses automatic replies for that chat for 30 minutes. This is a best-effort handover signal; WhatsApp does not provide a reliable online/offline signal to this integration.
- Workers Free has a 10 ms CPU limit for ordinary Worker invocations and a daily request allowance. Test the web app and WhatsApp session under real conditions before relying on it.
- All Free quotas are hard limits, not unlimited service. When a quota is reached, functionality may pause or fail until the quota resets. It must not trigger a paid upgrade.

## Security checklist

Before connecting any WhatsApp account:

- Set `CORS_ORIGIN` to the CRM's real origin.
- Set `BETTER_AUTH_URL` to the CRM's real URL.
- Set `ENGINE_INTERNAL_SECRET` in both Workers (the same secret).
- Set `WS_TOKEN_SECRET` in both Workers (the same secret).
- Keep the admin account protected with a strong unique password.
- Keep the Baileys test account separate from the business's main number until the integration is proven stable.

Baileys is an unofficial WhatsApp Web client. It can disconnect or expose the account to restrictions; never test first with the primary sales number.

## Current repository state

All free-plan adaptations are isolated on `adaptacion-cell-phone-store`. The draft PR is for validation only. Do not merge or deploy it until lint, typecheck, tests, and a real test-number session have passed. `main` remains untouched.
