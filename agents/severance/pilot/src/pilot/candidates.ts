import { PINNED_PRICES_USD_MONTH } from './guard.ts';
import { HANDOFF_IMAGES, isHttpsUrl, isSafeLabel, SANITY_MAX_USD, SANITY_MIN_USD } from './mandate.ts';

/**
 * The Agent 2 (Broker) → Agent 4 (Pilot) routing contract.
 * Broker lives at agents/severance/broker and emits scraped plan rows; every field
 * here is UNTRUSTED. `routeCandidate` validates before anything reaches a card,
 * a mandate, or a log.
 */
export interface VpsCandidate {
  vendor: string;
  plan: string;
  region: string;
  image: string;
  monthly_usd: number;
  source_url: string;
  scraped_at: string;
  specs: { vcpu: number; ram_gb: number; disk_gb: number };
  supports_cloud_init: boolean;
}

export type Lane = 'automated' | 'handoff' | 'unsupported';
export interface Routing {
  lane: Lane;
  /** Fixed strings and numbers only: never echoes a string that came from a candidate. */
  reason: string;
}

/** A vendor Pilot has a tested adapter and credentials for. */
export interface AutomatedVendor {
  vendor: string;
  /** Pinned price table (USD/month): the ceiling Pilot budgets against, not the scraped price. */
  plans: Record<string, number>;
  regions: string[];
}

/**
 * The extension point for a second automated vendor: add an entry here (and an adapter in
 * the gateway). Hetzner's regions are the three the pinned prices were checked for.
 */
export const AUTOMATED_VENDORS: AutomatedVendor[] = [
  { vendor: 'hetzner', plans: PINNED_PRICES_USD_MONTH, regions: ['fsn1', 'nbg1', 'hel1'] },
];

const isImage = (v: unknown): boolean => typeof v === 'string' && (HANDOFF_IMAGES as readonly string[]).includes(v);

export function routeCandidate(c: VpsCandidate, registry: AutomatedVendor[] = AUTOMATED_VENDORS): Routing {
  const unsupported = (reason: string): Routing => ({ lane: 'unsupported', reason });
  if (c === null || typeof c !== 'object') return unsupported('candidate is not an object');

  // 1. Untrusted strings: charset and length, before anything else looks at them.
  for (const f of ['vendor', 'plan', 'region'] as const) {
    if (!isSafeLabel(c[f])) return unsupported(`${f} is missing or has characters outside letters, digits, space . _ -`);
  }
  if (!isHttpsUrl(c.source_url)) return unsupported('source_url is missing or is not an https URL of at most 300 characters');

  // 2. Price sanity. A scrape that says $0.01 or $9999 is a parse error or an attack.
  if (typeof c.monthly_usd !== 'number' || !Number.isFinite(c.monthly_usd)) return unsupported('monthly_usd is not a number');
  if (c.monthly_usd < SANITY_MIN_USD || c.monthly_usd > SANITY_MAX_USD) {
    return unsupported(`monthly_usd outside the sanity band $${SANITY_MIN_USD}-$${SANITY_MAX_USD}`);
  }

  // 3. Automated: exact vendor (never a prefix or substring), and a plan and region we have pinned.
  const vendor = c.vendor.toLowerCase();
  const entry = registry.find((v) => v.vendor === vendor);
  if (entry && Object.hasOwn(entry.plans, c.plan.toLowerCase()) && entry.regions.includes(c.region.toLowerCase()) && isImage(c.image)) {
    return { lane: 'automated', reason: `Pilot has an adapter for this vendor; budgets against the pinned $${entry.plans[c.plan.toLowerCase()]}/mo, not the scraped price` };
  }

  // 4. Handoff: the vendor must let a human paste our cloud-init on an image it is written for.
  if (c.supports_cloud_init !== true) return unsupported('no cloud-init support: the pinned bootstrap cannot run on this server');
  if (!isImage(c.image)) return unsupported(`image is not one of ${HANDOFF_IMAGES.join(', ')}`);
  return { lane: 'handoff', reason: 'no adapter for this vendor; a human buys the server and registers its IP' };
}
