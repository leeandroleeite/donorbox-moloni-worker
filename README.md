# Donorbox → Moloni (Cloudflare Worker, TypeScript)

Simple TypeScript Cloudflare Worker that receives Donorbox webhooks and creates an invoice in Moloni (Flex plan friendly).

## Setup

1. Install deps (pins Wrangler locally): `npm install` (requires WSL2 or native Node; WSL1 is not supported by esbuild).
2. (Optional) Global Wrangler if you prefer: `npm install -g wrangler`.
3. Create secrets:
   ```
   cd donorbox-moloni-worker
   wrangler secret put DONORBOX_WEBHOOK_SECRET   # optional but recommended
   wrangler secret put MOLONI_CLIENT_ID
   wrangler secret put MOLONI_CLIENT_SECRET
   wrangler secret put MOLONI_REFRESH_TOKEN
   wrangler secret put MOLONI_COMPANY_ID
   wrangler secret put MOLONI_DOCUMENT_SET_ID    # Moloni series to use (required)
   wrangler secret put MOLONI_PRODUCT_ID         # Article used on the invoice line
   wrangler secret put MOLONI_TAX_ID             # optional
   wrangler secret put MOLONI_FALLBACK_EMAIL     # optional, used if donor email is missing
   ```
4. Dev server: `npm run dev` (local-only), Deploy: `npm run deploy`.
5. In Donorbox, add a webhook pointing to the Worker URL (HTTPS). Use the same secret if you enable signature validation.

## Notes

- The Worker validates `X-Donorbox-Signature` with HMAC (sha256/sha1). Leave `DONORBOX_WEBHOOK_SECRET` unset to skip.
- Mapping is in `src/worker.ts` (`mapDonorboxPayload` → `buildMoloniInvoicePayload`). Adjust fields to match your Moloni account (document set, product, taxes).
- Moloni endpoint used: `POST /v1/invoices/insert` with bearer token obtained via refresh token. Change the endpoint if your account uses a different path/contract.
- Responses bubble up Moloni API errors (HTTP 502 from the Worker) so Donorbox can retry. Add persistence (KV/Queue) if you need idempotency or dead-lettering.
- After creating the invoice, the Worker will attempt to email it via Moloni using the donor email or `MOLONI_FALLBACK_EMAIL`. Email failures are logged but do not block the webhook response.

## Local test

```
wrangler dev --local
curl -X POST http://127.0.0.1:8787 -H "Content-Type: application/json" -d '{"data":{"id":"demo-1","amount":25,"currency":"EUR","campaign_name":"General Fund","donor":{"name":"Test Donor","email":"demo@example.com"}}}'
```
