# Zero-cost Cloudflare profile

This document describes the changes in the `adaptacion-cell-phone-store` branch. It supersedes the original paid-resource setup notes for this branch.

## Reuse of the existing Cloudflare space

- The already deployed Worker `telegram-image-studio` is repurposed as the WhatsApp engine. Deploying the new engine replaces the old image-bot code on that Worker.
- The old D1 database `sia-image-studio-db` is deliberately left untouched and is not bound to Replyloom: its schema belongs to the image bot and is incompatible with the CRM database. Replyloom uses a separate D1 database named `whatsapp-ai`.
- The existing account-level Workers AI binding is reused directly. No Telegram bot token, webhook, or image-generation workflow is included.

## Resources used

- **Workers Free** for the web app and WhatsApp engine.
- **Durable Objects with SQLite** for WhatsApp sessions and atomic rate limiting.
- **D1** for workspace data, message history, and the text knowledge base.
- **Workers KV** for reply/config caching and bounded media storage.
- **Queues** for the existing background/broadcast workflow, subject to the Free daily operation allowance.
- **Workers AI** called directly through the AI binding.

No R2 bucket, Vectorize index, AI Gateway, or Cloudflare Rate Limiting API binding is required by the application.

## Important Free limits

These are service limits, not promises of unlimited usage. When a Free quota is reached, requests may fail or wait for the daily reset; this profile must not be upgraded to a paid plan or given a payment method.

| Service | Free allowance relevant to this app |
| --- | --- |
| Workers | 100,000 requests/day; 10 ms CPU per ordinary Worker invocation |
| Durable Objects | SQLite backend available on Free; 100,000 requests/day; 5 GB SQLite storage per account |
| D1 | 5 million rows read/day; 100,000 rows written/day; 500 MB maximum per database; 5 GB total account storage |
| KV | 100,000 reads/day; 1,000 writes/day; 1 GB storage; maximum value 25 MiB |
| Queues | 10,000 operations/day |
| Workers AI | 10,000 Neurons/day |

Official references:
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/kv/platform/limits/
- https://developers.cloudflare.com/queues/platform/pricing/
- https://developers.cloudflare.com/workers-ai/platform/pricing/

## Functional trade-offs

1. **Knowledge retrieval and message search:** Vectorize and embedding calls are removed. D1 performs accent-normalized text matching. This is not semantic search; it works best when product names, model numbers, prices, and important phrases are present in the saved knowledge documents.
2. **Media:** R2 is replaced by a separate KV namespace. Files larger than 24 MiB are not retained in the CRM. WhatsApp messages and captions still remain available as text when attachment storage is unavailable. KV's 1,000 daily writes are a hard limit, so media retention is best-effort.
3. **AI quota:** The assistant calls Workers AI directly. The intent classifier uses `@cf/zai-org/glm-4.7-flash` with reasoning disabled for short labels; grounded replies use `@cf/google/gemma-4-26b-a4b-it`. Both use the account's Free daily neuron allowance, with no AI Gateway. If the quota is exhausted or the provider is unavailable, the assistant sends a fixed, cautious message instead of guessing prices, stock, delivery, or payment details.
4. **Human takeover:** A manual outgoing message pauses automatic replies for that chat for 30 minutes. The timer extends when the seller sends another message. Replies resume automatically after the quiet period. This is only a best-effort signal; WhatsApp does not expose a reliable "seller is available/offline" signal to this integration.
5. **Backups:** The scheduled R2 backup workflow is removed. D1 Free includes a 7-day Time Travel recovery window, but that is not a substitute for a separate encrypted export. Do not run the optional `--cloud` config-backup commands in this zero-cost profile; they use R2.

## Safety and deployment state

- All code changes remain on `adaptacion-cell-phone-store`.
- The draft pull request is for CI review only.
- `main` has not been modified or merged.
- No Cloudflare resources have been created, no Worker has been deployed, and no WhatsApp account or QR code has been connected.
- Keep using only the secondary/test WhatsApp account until the code passes checks and the behavior is tested.
