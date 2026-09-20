import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

/**
 * A spend mandate is a single-use, expiring, cost-capped, scope-limited capability.
 * It is Ed25519-signed by an operator (`npm run mandate`), not by Broker.
 * Broker (Agent 2) mints a separate HMAC `severance.cart_mandate/v1` after human
 * approval; Pilot verifies that cart, then parks until a spend mandate arrives.
 * Every field below is enforced by the guard, not by the agent's prompt.
 */
export interface Mandate {
  mandate_id: string;
  nonce: string;
  iat: string;
  exp: string;
  approved_by: string;
  scope: string[];
  budget: { max_monthly_usd: number; max_hourly_usd: number };
  provision: Provision;
  migration: {
    vercel_project_id: string;
    git_repository: string;
    git_branch: string;
    domain: string;
  };
  /** Agent 1's sealed capacity prediction, so Agent 5 can verify the chain. */
  surveyor_prediction_sha256: string;
  /**
   * `exp` bounds authority to START spending. Once the server is bought, later steps
   * (boot, deploy, audit, cutover) may run for this many minutes from the purchase.
   * Default 120. Without this a normal 8-minute Coolify install outlives a 10-minute
   * mandate and every run rolls back mid-flight.
   */
  run_window_minutes?: number;
}

/** Pilot buys the server itself (today: Hetzner only). */
export interface HetznerProvision {
  provider: 'hetzner';
  server_type: string;
  image: string;
  location: string;
  count: number;
  cloud_init_sha256: string;
}

/**
 * A human buys the server on the vendor's site; Pilot continues from boot. The price is
 * ADVISORY: the human pays, so nothing here can be enforced as a spend cap.
 */
export interface HandoffProvision {
  provider: 'handoff';
  vendor: string;
  plan: string;
  region: string;
  image: string;
  expected_monthly_usd: number;
  /** Where Agent 2 saw the price. Shown to the human, never fetched. */
  source_url: string;
  count: 1;
  cloud_init_sha256: string;
}

export type Provision = HetznerProvision | HandoffProvision;
export type HandoffMandate = Mandate & { provision: HandoffProvision };
export type HetznerMandate = Mandate & { provision: HetznerProvision };

export const isHandoff = (m: Mandate): m is HandoffMandate => m.provision.provider === 'handoff';

/** Refuse prices outside this band even if a table or a scrape says otherwise. */
export const SANITY_MIN_USD = 1;
export const SANITY_MAX_USD = 500;

/** Images the pinned cloud-init template is written for. */
export const HANDOFF_IMAGES = ['ubuntu-22.04', 'ubuntu-24.04'] as const;
export const HANDOFF_SCOPES = ['handoff:prepare', 'handoff:register', 'handoff:status'];

/** Strings that came from a scrape (Agent 2) may only contain these, so they cannot carry markup or newlines. */
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;
export const isSafeLabel = (v: unknown): v is string => typeof v === 'string' && SAFE_LABEL.test(v);

export function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 300 || !/^https:\/\/[^\s`<>"']+$/.test(v)) return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

export type Refusal = { ok: false; code: string; reason: string };
export type Verified = { ok: true; mandate: Mandate };

/** Deterministic serialization: recursively key-sorted JSON. Signing requires it. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

const b64u = (b: Buffer) => b.toString('base64url');

/** Detached-payload JWS-like envelope: <base64url(payload)>.<base64url(ed25519 sig)>. */
export function signMandate(mandate: Mandate, privateKey: KeyObject | string): string {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const payload = Buffer.from(canonicalize(mandate), 'utf8');
  return `${b64u(payload)}.${b64u(sign(null, payload, key))}`;
}

const REQUIRED_SCOPES = /^[a-z0-9_]+:[a-z0-9_.*]+$/;

/**
 * Verifies signature, freshness and structure. Does NOT check single-use — that is
 * the ledger's job, and it must happen write-ahead. See `ledger.ts`.
 */
export function verifyMandate(
  token: string,
  opts: { publicKey: KeyObject | string; now?: Date; maxSkewMs?: number; allowExpired?: boolean },
): Verified | Refusal {
  const now = opts.now ?? new Date();
  const skew = opts.maxSkewMs ?? 30_000;

  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, code: 'MALFORMED', reason: 'expected <payload>.<sig>' };
  const [payloadB64, sigB64] = parts as [string, string];

  let payload: Buffer;
  let sig: Buffer;
  try {
    payload = Buffer.from(payloadB64, 'base64url');
    sig = Buffer.from(sigB64, 'base64url');
  } catch {
    return { ok: false, code: 'MALFORMED', reason: 'bad base64url' };
  }

  const key = typeof opts.publicKey === 'string' ? createPublicKey(opts.publicKey) : opts.publicKey;
  if (!verify(null, payload, key, sig)) {
    return { ok: false, code: 'BAD_SIGNATURE', reason: 'signature does not verify' };
  }

  let mandate: Mandate;
  try {
    mandate = JSON.parse(payload.toString('utf8')) as Mandate;
  } catch {
    return { ok: false, code: 'MALFORMED', reason: 'payload is not JSON' };
  }

  // Re-canonicalizing must reproduce the signed bytes exactly, otherwise a field was
  // appended outside the signature's view.
  if (canonicalize(mandate) !== payload.toString('utf8')) {
    return { ok: false, code: 'NON_CANONICAL', reason: 'payload is not canonical; possible field injection' };
  }

  for (const field of ['mandate_id', 'nonce', 'approved_by', 'surveyor_prediction_sha256'] as const) {
    if (!mandate[field]) return { ok: false, code: 'MISSING_FIELD', reason: `${field} is required` };
  }
  if (!Array.isArray(mandate.scope) || mandate.scope.length === 0) {
    return { ok: false, code: 'MISSING_FIELD', reason: 'scope is required' };
  }
  if (!mandate.scope.every((s) => REQUIRED_SCOPES.test(s))) {
    return { ok: false, code: 'BAD_SCOPE', reason: 'scope entries must look like provider:action' };
  }
  if (!(mandate.budget?.max_monthly_usd > 0)) {
    return { ok: false, code: 'NO_BUDGET', reason: 'budget.max_monthly_usd must be positive' };
  }
  if (!Number.isInteger(mandate.provision?.count) || mandate.provision.count < 1) {
    return { ok: false, code: 'BAD_COUNT', reason: 'provision.count must be a positive integer' };
  }

  const provider = (mandate.provision as { provider?: unknown }).provider;
  if (provider === 'handoff') {
    const bad = handoffProblem(mandate.provision as HandoffProvision);
    if (bad) return { ok: false, code: 'BAD_PROVISION', reason: bad };
  } else if (provider !== 'hetzner') {
    return { ok: false, code: 'BAD_PROVIDER', reason: 'provision.provider must be hetzner or handoff' };
  }

  const iat = Date.parse(mandate.iat);
  const exp = Date.parse(mandate.exp);
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) {
    return { ok: false, code: 'BAD_TIME', reason: 'iat/exp must be ISO 8601' };
  }
  if (!opts.allowExpired && now.getTime() > exp) {
    return { ok: false, code: 'EXPIRED', reason: `mandate expired at ${mandate.exp}` };
  }
  if (iat - now.getTime() > skew) {
    return { ok: false, code: 'NOT_YET_VALID', reason: 'iat is in the future' };
  }

  return { ok: true, mandate };
}

/** Returns why a handoff provision is malformed, or null. Reasons never echo the offending value. */
function handoffProblem(p: HandoffProvision): string | null {
  for (const f of ['vendor', 'plan', 'region'] as const) {
    if (!isSafeLabel(p[f])) return `provision.${f} must be 1-60 characters of letters, digits, space . _ -`;
  }
  if (!(HANDOFF_IMAGES as readonly string[]).includes(p.image)) {
    return `provision.image must be one of ${HANDOFF_IMAGES.join(', ')}`;
  }
  if (typeof p.expected_monthly_usd !== 'number' || !(p.expected_monthly_usd >= SANITY_MIN_USD && p.expected_monthly_usd <= SANITY_MAX_USD)) {
    return `provision.expected_monthly_usd must be between ${SANITY_MIN_USD} and ${SANITY_MAX_USD}`;
  }
  if (!isHttpsUrl(p.source_url)) return 'provision.source_url must be an https URL of at most 300 characters';
  if (p.count !== 1) return 'a handoff mandate authorises exactly one server';
  if (typeof p.cloud_init_sha256 !== 'string' || !/^[0-9a-f]{8,64}$/.test(p.cloud_init_sha256)) {
    return 'provision.cloud_init_sha256 must be lowercase hex';
  }
  return null;
}
