import { createHmac, timingSafeEqual } from 'node:crypto';

export const SCHEMA_CART = 'severance.cart_mandate/v1';
export const SIGNATURE_KID = 'severance-2026';
export const SIGNATURE_ALG = 'HMAC-SHA256';

export type CartMandate = {
  schema?: string;
  mandate_id: string;
  nonce: string;
  issued_at: string;
  expires_at: string;
  decision: {
    provider: string;
    plan_sku: string;
    region: string;
    monthly_inr: number;
    listed_price?: { amount: number; currency: string };
    source_url?: string;
    [key: string]: unknown;
  };
  constraints_applied: {
    ceiling_inr_monthly: number;
    [key: string]: unknown;
  };
  approval?: { status?: string; approver?: string | null; approved_at?: string | null };
  signature: { alg: string; kid: string; value: string };
  [key: string]: unknown;
};

export type CartVerifyOk = { ok: true; mandate: CartMandate };
export type CartVerifyFail = { ok: false; code: string; reason: string };
export type CartVerifyResult = CartVerifyOk | CartVerifyFail;

/** Sorted-keys, no-whitespace JSON — matches Broker's canonical_dumps. */
export function canonicalDumps(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalDumps).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalDumps(v)}`).join(',')}}`;
}

function signingKey(secret: string): Buffer {
  try {
    const hex = Buffer.from(secret, 'hex');
    if (hex.length >= 16 && secret.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(secret)) return hex;
  } catch {
    /* fall through */
  }
  const key = Buffer.from(secret, 'utf8');
  if (key.length < 16) throw new Error('MANDATE_SIGNING_SECRET must be at least 16 bytes');
  return key;
}

function unsignedPayload(mandate: CartMandate): Record<string, unknown> {
  const { signature: _s, approval: _a, ...rest } = mandate;
  return rest;
}

export function looksLikeCartMandate(text: string): CartMandate | null {
  const trimmed = text.trim();
  if (!trimmed.includes(SCHEMA_CART) && !trimmed.includes('mandate_id')) return null;
  try {
    const start = trimmed.indexOf('{');
    const data = JSON.parse(start >= 0 ? trimmed.slice(start) : trimmed) as CartMandate;
    if (data?.schema === SCHEMA_CART || (data?.mandate_id && data?.signature && data?.decision)) {
      return data;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Independent Pilot checks: HMAC, then monthly_inr <= ceiling, then expiry.
 * Same contract Broker's README documents for severance-pilot.
 */
export function verifyCartMandate(
  mandate: CartMandate,
  secret: string,
  opts: { now?: Date; checkExpiry?: boolean } = {},
): CartVerifyResult {
  if (mandate.signature?.kid !== SIGNATURE_KID) {
    return { ok: false, code: 'UNKNOWN_KID', reason: `unknown signature kid ${mandate.signature?.kid}` };
  }
  if (mandate.signature?.alg !== SIGNATURE_ALG) {
    return { ok: false, code: 'UNSUPPORTED_ALG', reason: `unsupported alg ${mandate.signature?.alg}` };
  }
  let key: Buffer;
  try {
    key = signingKey(secret);
  } catch (e) {
    return { ok: false, code: 'NO_SECRET', reason: e instanceof Error ? e.message : String(e) };
  }
  const body = canonicalDumps(unsignedPayload(mandate));
  const expected = createHmac('sha256', key).update(body, 'utf8').digest('hex');
  const got = mandate.signature.value ?? '';
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(got, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, code: 'BAD_SIGNATURE', reason: 'HMAC-SHA256 does not match canonical payload' };
  }
  const monthly = mandate.decision?.monthly_inr;
  const ceiling = mandate.constraints_applied?.ceiling_inr_monthly;
  if (typeof monthly !== 'number' || typeof ceiling !== 'number') {
    return { ok: false, code: 'BAD_MANDATE', reason: 'missing monthly_inr or ceiling' };
  }
  if (monthly > ceiling) {
    return { ok: false, code: 'OVER_CEILING', reason: `${monthly} > ${ceiling}` };
  }
  if (opts.checkExpiry !== false) {
    const exp = Date.parse(mandate.expires_at);
    const now = (opts.now ?? new Date()).getTime();
    if (!Number.isFinite(exp) || exp <= now) {
      return { ok: false, code: 'EXPIRED', reason: `mandate ${mandate.mandate_id} expired at ${mandate.expires_at}` };
    }
  }
  return { ok: true, mandate };
}

/** Map a Broker decision into a VpsCandidate-shaped routing input. */
export function candidateFromCart(mandate: CartMandate) {
  const d = mandate.decision;
  const amount = d.listed_price?.amount;
  const currency = (d.listed_price?.currency ?? 'USD').toUpperCase();
  let monthlyUsd = typeof amount === 'number' ? amount : d.monthly_inr / 83;
  if (currency === 'EUR' && typeof amount === 'number') monthlyUsd = amount * 1.1;
  if (currency === 'INR') monthlyUsd = d.monthly_inr / 83;
  return {
    vendor: String(d.provider ?? '').toLowerCase(),
    plan: String(d.plan_sku ?? ''),
    region: String(d.region ?? ''),
    image: 'ubuntu-24.04',
    monthly_usd: monthlyUsd,
    source_url: typeof d.source_url === 'string' ? d.source_url : 'https://example.com/pricing',
    scraped_at: new Date().toISOString(),
    specs: { vcpu: 2, ram_gb: 4, disk_gb: 40 },
    supports_cloud_init: true,
  };
}
