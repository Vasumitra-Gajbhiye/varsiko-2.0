import { devMandate } from '../../src/pilot/demo.ts';
import type { HandoffProvision, Mandate } from '../../src/pilot/mandate.ts';

export const handoffProvision = (over: Partial<HandoffProvision> = {}): HandoffProvision => ({
  provider: 'handoff',
  vendor: 'contabo',
  plan: 'cloud-vps-10',
  region: 'eu-central',
  image: 'ubuntu-24.04',
  expected_monthly_usd: 5.5,
  source_url: 'https://example.com/pricing',
  count: 1,
  cloud_init_sha256: '9c1e7f3a',
  ...over,
});

/** A handoff mandate with the scope a real one carries (no hetzner, no anakin). */
export const handoffMandate = (over: Partial<Mandate> = {}, prov: Partial<HandoffProvision> = {}): Mandate => ({
  ...devMandate(),
  scope: ['handoff:prepare', 'handoff:register', 'handoff:status', 'coolify:*', 'cloudflare:dns.upsert', 'cloudflare:dns.rollback', 'vercel:env.export'],
  // A human buying a server takes hours, not minutes: handoff mandates get a long start window.
  exp: '2026-09-21T14:55:00Z',
  budget: { max_monthly_usd: 5.5, max_hourly_usd: 0.01 },
  provision: handoffProvision(prov),
  ...over,
});
