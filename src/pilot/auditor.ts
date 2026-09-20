import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalize } from './mandate.ts';

/**
 * Agent 5's pass verdict, as evidence rather than a string. The token is signed by the
 * Auditor's key and bound to ONE mandate and ONE server IP, so a PASS for one
 * deployment cannot be replayed to cut over a different one.
 */
export interface AuditorClaims {
  mandate_id: string;
  server_ip: string;
  verdict: 'PASS';
  iat: string;
  exp: string;
}

const b64u = (b: Buffer) => b.toString('base64url');

export function signAuditorToken(claims: AuditorClaims, key: KeyObject | string): string {
  const k = typeof key === 'string' ? createPrivateKey(key) : key;
  const payload = Buffer.from(canonicalize(claims), 'utf8');
  return `${b64u(payload)}.${b64u(sign(null, payload, k))}`;
}

export type AuditorCheck = { ok: true; claims: AuditorClaims } | { ok: false; code: string; reason: string };

export function verifyAuditorToken(
  token: string,
  opts: { publicKey: KeyObject | string; mandate_id: string; server_ip: string; now?: Date },
): AuditorCheck {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, code: 'AUDITOR_MALFORMED', reason: 'expected <payload>.<sig>' };
  const payload = Buffer.from(parts[0]!, 'base64url');
  const key = typeof opts.publicKey === 'string' ? createPublicKey(opts.publicKey) : opts.publicKey;
  if (!verify(null, payload, key, Buffer.from(parts[1]!, 'base64url'))) {
    return { ok: false, code: 'AUDITOR_BAD_SIGNATURE', reason: 'auditor signature does not verify' };
  }
  let c: AuditorClaims;
  try {
    c = JSON.parse(payload.toString('utf8')) as AuditorClaims;
  } catch {
    return { ok: false, code: 'AUDITOR_MALFORMED', reason: 'payload is not JSON' };
  }
  if (canonicalize(c) !== payload.toString('utf8')) {
    return { ok: false, code: 'AUDITOR_MALFORMED', reason: 'payload is not canonical' };
  }
  if (c.verdict !== 'PASS') return { ok: false, code: 'AUDITOR_NOT_PASS', reason: `verdict is ${String(c.verdict)}` };
  if (c.mandate_id !== opts.mandate_id) return { ok: false, code: 'AUDITOR_WRONG_MANDATE', reason: 'token is for a different mandate' };
  if (c.server_ip !== opts.server_ip) return { ok: false, code: 'AUDITOR_WRONG_SERVER', reason: 'token is for a different server' };
  if ((opts.now ?? new Date()).getTime() > Date.parse(c.exp)) return { ok: false, code: 'AUDITOR_EXPIRED', reason: 'auditor token expired' };
  return { ok: true, claims: c };
}
