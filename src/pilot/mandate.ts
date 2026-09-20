import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

/**
 * A mandate is a single-use, expiring, cost-capped, scope-limited capability.
 * Broker (Agent 2) signs it after human approval. Pilot (Agent 4) carries it but
 * cannot read or alter it meaningfully: every field below is enforced downstream
 * by the guard, not by the agent's prompt.
 */
export interface Mandate {
  mandate_id: string;
  nonce: string;
  iat: string;
  exp: string;
  approved_by: string;
  scope: string[];
  budget: { max_monthly_usd: number; max_hourly_usd: number };
  provision: {
    provider: 'hetzner';
    server_type: string;
    image: string;
    location: string;
    count: number;
    cloud_init_sha256: string;
  };
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
