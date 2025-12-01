/**
 * Cloudflare Worker: Donorbox webhook -> Moloni invoice creation (Flex-friendly).
 */

interface Env {
  DONORBOX_WEBHOOK_SECRET?: string;
  MOLONI_CLIENT_ID: string;
  MOLONI_CLIENT_SECRET: string;
  MOLONI_REFRESH_TOKEN: string;
  MOLONI_COMPANY_ID: string;
  MOLONI_DOCUMENT_SET_ID: string;
  MOLONI_PRODUCT_ID: string;
  MOLONI_TAX_ID?: string;
  MOLONI_FALLBACK_EMAIL?: string;
}

type DonorboxPayload = Record<string, unknown> & {
  data?: Record<string, unknown>;
  donation?: Record<string, unknown>;
  donor?: Record<string, unknown>;
};

type Donation = {
  externalId?: string | number;
  name: string;
  email?: string;
  amount: number;
  currency: string;
  campaign: string;
  raw: Record<string, unknown>;
};

type MoloniInvoiceInput = {
  company_id: string;
  document_set_id: string;
  date: string;
  expiration_date: string;
  notes?: string;
  customer: {
    name: string;
    email?: string;
  };
  products: Array<{
    product_id: string;
    name: string;
    summary: string;
    qty: number;
    price: number;
    discount: number;
    taxes: Array<{ tax_id: string }>;
  }>;
  currency: string;
  metadata?: Record<string, unknown>;
};

const MOLONI_API_BASE = "https://api.moloni.pt/v1";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Expected POST", { status: 405 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-donorbox-signature") || request.headers.get("X-Donorbox-Signature");

    if (env.DONORBOX_WEBHOOK_SECRET) {
      const ok = await validateDonorboxSignature(rawBody, signature, env.DONORBOX_WEBHOOK_SECRET);
      if (!ok) {
        return new Response("Invalid signature", { status: 401 });
      }
    }

    let payload: DonorboxPayload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const donation = mapDonorboxPayload(payload);
    if (!donation.amount || !donation.currency) {
      return new Response("Missing amount or currency from Donorbox payload", { status: 422 });
    }

    const moloni = new MoloniClient(env);
    const invoiceInput = buildMoloniInvoicePayload(donation, env);

    try {
      const invoice = await moloni.createInvoice(invoiceInput);
      const invoiceId = extractInvoiceId(invoice);
      const recipient = donation.email || env.MOLONI_FALLBACK_EMAIL;

      if (invoiceId && recipient) {
        moloni.sendInvoiceEmail(invoiceId, recipient).catch((err) => {
          console.error("Failed to email invoice via Moloni:", err);
        });
      }

      return Response.json({ ok: true, invoice });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return new Response(`Moloni error: ${message}`, { status: 502 });
    }
  },
};

async function validateDonorboxSignature(bodyText: string, headerValue: string | null, secret: string): Promise<boolean> {
  if (!headerValue) return false;

  const [maybeAlgo, maybeSig] = headerValue.includes("=") ? headerValue.split("=", 2) : ["sha256", headerValue];
  const algo = maybeAlgo.toLowerCase() === "sha1" ? "SHA-1" : "SHA-256";
  const provided = maybeSig.trim();

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: algo }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(bodyText));
  const expectedHex = bufferToHex(signature);

  return timingSafeEqual(expectedHex, provided);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mapDonorboxPayload(payload: DonorboxPayload): Donation {
  const data = (payload?.data as Record<string, unknown>) || (payload?.donation as Record<string, unknown>) || payload || {};
  const donor = (data.donor as Record<string, unknown>) || (data.donor_info as Record<string, unknown>) || {};

  const name =
    (donor.name as string) ||
    [donor.first_name as string, donor.last_name as string].filter(Boolean).join(" ").trim() ||
    "Donorbox Donor";
  const email = (donor.email as string) || (data.email as string) || undefined;
  const amount = Number(data.amount ?? data.donation_amount ?? data.total ?? 0);
  const currency = String((data.currency as string) || (data.currency_code as string) || "EUR").toUpperCase();
  const campaign =
    (data.campaign_name as string) ||
    (data.campaign_title as string) ||
    (data.designation as string) ||
    "Donation";

  return {
    externalId: (data.id as string) || (payload as Record<string, unknown>).id || (payload as Record<string, unknown>).event_id,
    name,
    email,
    amount,
    currency,
    campaign,
    raw: data,
  };
}

function buildMoloniInvoicePayload(donation: Donation, env: Env): MoloniInvoiceInput {
  const today = new Date().toISOString().slice(0, 10);
  const lineName = `Donation - ${donation.campaign}`;

  return {
    company_id: env.MOLONI_COMPANY_ID,
    document_set_id: env.MOLONI_DOCUMENT_SET_ID,
    date: today,
    expiration_date: today,
    notes: `Donorbox donation ${donation.externalId || ""}`.trim(),
    customer: {
      name: donation.name,
      email: donation.email,
    },
    products: [
      {
        product_id: env.MOLONI_PRODUCT_ID,
        name: lineName,
        summary: lineName,
        qty: 1,
        price: donation.amount,
        discount: 0,
        taxes: env.MOLONI_TAX_ID ? [{ tax_id: env.MOLONI_TAX_ID }] : [],
      },
    ],
    currency: donation.currency,
    metadata: {
      donorbox_id: donation.externalId,
      campaign: donation.campaign,
    },
  };
}

function extractInvoiceId(invoice: unknown): string | null {
  const obj = invoice as Record<string, unknown>;
  const maybeId = (obj?.document_id || obj?.documentId || obj?.id) as string | number | undefined;
  if (maybeId === undefined || maybeId === null) return null;
  return String(maybeId);
}

class MoloniClient {
  private env: Env;
  private cachedToken: string | null;
  private tokenExpiresAt: number;

  constructor(env: Env) {
    this.env = env;
    this.cachedToken = null;
    this.tokenExpiresAt = 0;
  }

  async createInvoice(invoicePayload: MoloniInvoiceInput): Promise<unknown> {
    const accessToken = await this.getAccessToken();

    const resp = await fetch(`${MOLONI_API_BASE}/invoices/insert`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(invoicePayload),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${text}`);
    }

    return resp.json();
  }

  async sendInvoiceEmail(documentId: string, to: string): Promise<void> {
    const accessToken = await this.getAccessToken();

    const body = {
      document_id: documentId,
      email: to,
      company_id: this.env.MOLONI_COMPANY_ID,
    };

    const resp = await fetch(`${MOLONI_API_BASE}/invoices/sendEmail`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Email send failed: HTTP ${resp.status}: ${text}`);
    }
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.env.MOLONI_CLIENT_ID,
      client_secret: this.env.MOLONI_CLIENT_SECRET,
      refresh_token: this.env.MOLONI_REFRESH_TOKEN,
    });

    const resp = await fetch(`${MOLONI_API_BASE}/grant/?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Auth failed: HTTP ${resp.status}: ${text}`);
    }

    const json = (await resp.json()) as { access_token: string; expires_in?: number };
    const expiresInMs = Number(json.expires_in || 900) * 1000;
    this.cachedToken = json.access_token;
    this.tokenExpiresAt = Date.now() + expiresInMs - 30_000;
    return this.cachedToken;
  }
}
