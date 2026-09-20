/**
 * Price cross-check via Anakin.
 *
 * Trust model: the scraped page is UNTRUSTED INPUT that sits next to a spending
 * decision. It is therefore allowed exactly one effect — to make Pilot more
 * conservative:
 *
 *   effective_price = max(pinned_price, scraped_price)
 *
 * A page can raise the price Pilot budgets against (and so trigger a halt), never
 * lower it, and it can never touch the mandate's cap. Extraction is a regex over a
 * table row, not an LLM, so there is nothing in the page to "persuade".
 */

/** The only URL Pilot may ask Anakin to scrape. Enforced in guard.ts and again server-side. */
export const PRICE_SOURCE_URL = 'https://www.hetzner.com/cloud';

/** Approximate. Only ever used to compare, and only in the conservative direction. */
export const FX_TO_USD: Record<string, number> = { USD: 1, EUR: 1.1 };

/** Amounts outside this band are treated as parse errors, not prices. */
const SANITY_MIN = 1;
const SANITY_MAX = 500;

export interface ScrapedPrice {
  amount: number;
  currency: 'USD' | 'EUR';
  /** The matched table row, stripped and truncated. Safe to log. */
  evidence: string;
}

const AMOUNT = /(€|\$|EUR|USD)?\s?(\d{1,3}(?:[.,]\d{1,2})?)\s?(€|\$|EUR|USD)?/gi;

const clean = (s: string) =>
  s
    .replace(/[^\x20-\x7E€]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

/**
 * Finds the monthly price on the first table row that mentions the server type.
 * Returns null rather than guessing when the row is missing or ambiguous.
 */
export function extractMonthlyPrice(markdown: string, serverType: string): ScrapedPrice | null {
  const t = /^([a-z]+)(\d+)$/i.exec(serverType);
  if (!t) return null;
  const typeRe = new RegExp(`\\b${t[1]}\\s?${t[2]}\\b`, 'i');

  for (const line of markdown.split('\n')) {
    if (!typeRe.test(line)) continue;

    const candidates: { amount: number; currency: 'USD' | 'EUR'; monthly: boolean }[] = [];
    for (const m of line.matchAll(AMOUNT)) {
      const symbol = m[1] ?? m[3];
      if (!symbol) continue; // "4 GB" and "8 vCPU" are not prices
      const amount = Number((m[2] ?? '').replace(',', '.'));
      if (!Number.isFinite(amount) || amount < SANITY_MIN || amount > SANITY_MAX) continue;

      const tail = line.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 10).toLowerCase();
      if (/\/\s?(h|hr|hour)|per hour/.test(tail)) continue; // hourly rate, not monthly
      candidates.push({
        amount,
        currency: /€|eur/i.test(symbol) ? 'EUR' : 'USD',
        monthly: /mo|month/.test(tail),
      });
    }
    if (!candidates.length) continue;

    const monthly = candidates.filter((c) => c.monthly);
    const pool = monthly.length ? monthly : candidates;
    const best = pool.reduce((a, b) => (b.amount > a.amount ? b : a));
    return { amount: best.amount, currency: best.currency, evidence: clean(line) };
  }
  return null;
}

export interface PriceCheck {
  verdict: 'VERIFIED' | 'UNVERIFIED';
  pinned_usd: number;
  scraped_usd?: number;
  /** What the budget check will use. Never below pinned_usd. */
  effective_usd: number;
  reason: string;
  evidence?: string;
}

export function assessPrice(
  serverType: string,
  pinnedUsd: number,
  markdown: string | null,
  fx: Record<string, number> = FX_TO_USD,
): PriceCheck {
  const unverified = (reason: string): PriceCheck => ({
    verdict: 'UNVERIFIED',
    pinned_usd: pinnedUsd,
    effective_usd: pinnedUsd,
    reason,
  });

  if (markdown === null) return unverified('no page content');
  const scraped = extractMonthlyPrice(markdown, serverType);
  if (!scraped) return unverified(`no monthly price found for ${serverType} on the page`);

  const rate = fx[scraped.currency];
  if (rate === undefined) return unverified(`no FX rate for ${scraped.currency}`);

  const scrapedUsd = Math.round(scraped.amount * rate * 100) / 100;
  const effective = Math.max(pinnedUsd, scrapedUsd);
  return {
    verdict: 'VERIFIED',
    pinned_usd: pinnedUsd,
    scraped_usd: scrapedUsd,
    effective_usd: effective,
    evidence: scraped.evidence,
    reason:
      scrapedUsd > pinnedUsd
        ? `page is $${scrapedUsd} vs pinned $${pinnedUsd}; budgeting against the higher figure`
        : `page $${scrapedUsd} <= pinned $${pinnedUsd}; keeping the pinned figure`,
  };
}
