import type { Mandate } from './mandate.ts';
import { PRICE_SOURCE_URL } from './pricing.ts';

/**
 * Pinned fallback price table (USD/month).
 *
 * Two reasons this exists rather than trusting Agent 2's scrape:
 *  1. Scraped pricing is untrusted input that drives spending. A vendor page edit,
 *     or an injection in it, must not be able to raise the ceiling.
 *  2. A vendor redesign mid-demo cannot break the run.
 *
 * VERIFY before the demo — these are approximations, not scraped values.
 *
 * TODO(live test B0): replace with the real prices from the Hetzner console. Hetzner may
 * price in EUR while this table and the budget check are USD; `npm run mandate` prints the
 * value it checks against so the operator sees it before signing.
 */
export const PINNED_PRICES_USD_MONTH: Record<string, number> = {
  cx22: 4.5,
  cx32: 7.5,
  cpx11: 5.0,
  cpx21: 8.5,
  cpx31: 15.5,
  cpx41: 28.0,
  cpx51: 60.0,
};

/** Refuse anything outside this band even if the table or a scrape says otherwise. */
const SANITY_MIN_USD = 1;
const SANITY_MAX_USD = 500;

export type Decision =
  | { allow: true; estimated_monthly_usd: number }
  | { allow: false; code: string; reason: string };

function scopeCovers(scope: string[], action: string): boolean {
  return scope.some((entry) => {
    if (entry === action) return true;
    const [ns, verb] = entry.split(':');
    const [ans, averb] = action.split(':');
    if (ns !== ans) return false;
    if (verb === '*') return true;
    return verb?.endsWith('*') ? (averb ?? '').startsWith(verb.slice(0, -1)) : false;
  });
}

/**
 * The substitution guard. Every provisioning parameter must equal the mandate's value.
 *
 * This is deliberately not a prompt rule. Nasiko's per-agent tool permissions are
 * default-allow and operate on tool *names* with glob patterns — they cannot inspect
 * arguments. So "never swap the server type for a bigger one" has to be enforced here,
 * in the tool implementation, or it is not enforced at all.
 */
export function authorize(
  mandate: Mandate,
  toolName: string,
  args: Record<string, unknown>,
  opts: { auditorPassToken?: string; priceTable?: Record<string, number> } = {},
): Decision {
  const prices = opts.priceTable ?? PINNED_PRICES_USD_MONTH;

  switch (toolName) {
    case 'hetzner:server.create': {
      if (!scopeCovers(mandate.scope, 'hetzner:server.create')) {
        return { allow: false, code: 'OUT_OF_SCOPE', reason: 'mandate scope excludes hetzner:server.create' };
      }
      const pinned: [string, unknown, unknown][] = [
        ['server_type', args.server_type, mandate.provision.server_type],
        ['image', args.image, mandate.provision.image],
        ['location', args.location, mandate.provision.location],
        ['count', args.count, mandate.provision.count],
        ['cloud_init_sha256', args.cloud_init_sha256, mandate.provision.cloud_init_sha256],
      ];
      for (const [field, got, want] of pinned) {
        if (got !== want) {
          return {
            allow: false,
            code: 'PARAM_SUBSTITUTION',
            reason: `${field}: mandate pins ${JSON.stringify(want)}, call requested ${JSON.stringify(got)}`,
          };
        }
      }
      const unit = prices[mandate.provision.server_type];
      if (unit === undefined) {
        return { allow: false, code: 'UNPRICED', reason: `no pinned price for ${mandate.provision.server_type}` };
      }
      if (unit < SANITY_MIN_USD || unit > SANITY_MAX_USD) {
        return { allow: false, code: 'PRICE_INSANE', reason: `price ${unit} outside sanity band` };
      }
      const estimated = unit * mandate.provision.count;
      if (estimated > mandate.budget.max_monthly_usd) {
        return {
          allow: false,
          code: 'OVER_BUDGET',
          reason: `estimated $${estimated}/mo exceeds cap $${mandate.budget.max_monthly_usd}`,
        };
      }
      return { allow: true, estimated_monthly_usd: estimated };
    }

    case 'cloudflare:dns.upsert': {
      if (!scopeCovers(mandate.scope, 'cloudflare:dns.upsert')) {
        return { allow: false, code: 'OUT_OF_SCOPE', reason: 'mandate scope excludes cloudflare:dns.upsert' };
      }
      // DNS is the only irreversible step. It requires Agent 5's verdict, not just approval.
      if (!opts.auditorPassToken) {
        return { allow: false, code: 'NO_AUDITOR_TOKEN', reason: 'DNS cutover requires an Auditor pass token' };
      }
      if (args.name !== mandate.migration.domain) {
        return {
          allow: false,
          code: 'PARAM_SUBSTITUTION',
          reason: `domain: mandate pins ${mandate.migration.domain}, call requested ${String(args.name)}`,
        };
      }
      return { allow: true, estimated_monthly_usd: 0 };
    }

    case 'anakin:scrape.submit': {
      if (!scopeCovers(mandate.scope, toolName)) {
        return { allow: false, code: 'OUT_OF_SCOPE', reason: `mandate scope excludes ${toolName}` };
      }
      // One URL only. Otherwise a steered agent could use the scraper as an open fetch tool.
      if (args.url !== PRICE_SOURCE_URL) {
        return { allow: false, code: 'URL_NOT_ALLOWED', reason: `only ${PRICE_SOURCE_URL} may be scraped` };
      }
      return { allow: true, estimated_monthly_usd: 0 };
    }

    case 'coolify:project.create': {
      if (!scopeCovers(mandate.scope, toolName)) {
        return { allow: false, code: 'OUT_OF_SCOPE', reason: `mandate scope excludes ${toolName}` };
      }
      if (args.name !== mandate.migration.vercel_project_id) {
        return { allow: false, code: 'PARAM_SUBSTITUTION', reason: 'project name is pinned by the mandate' };
      }
      return { allow: true, estimated_monthly_usd: 0 };
    }

    case 'coolify:application.create': {
      if (!scopeCovers(mandate.scope, toolName)) {
        return { allow: false, code: 'OUT_OF_SCOPE', reason: `mandate scope excludes ${toolName}` };
      }
      // The repo is code that will run on a box holding the migrated secrets. Pin it.
      for (const [field, want] of [
        ['git_repository', mandate.migration.git_repository],
        ['git_branch', mandate.migration.git_branch],
      ] as const) {
        if (args[field] !== want) {
          return {
            allow: false,
            code: 'PARAM_SUBSTITUTION',
            reason: `${field}: mandate pins ${JSON.stringify(want)}, call requested ${JSON.stringify(args[field])}`,
          };
        }
      }
      return { allow: true, estimated_monthly_usd: 0 };
    }

    case 'vercel:env.export': {
      if (!scopeCovers(mandate.scope, toolName)) {
        return { allow: false, code: 'OUT_OF_SCOPE', reason: `mandate scope excludes ${toolName}` };
      }
      if (args.project_id !== mandate.migration.vercel_project_id) {
        return { allow: false, code: 'PARAM_SUBSTITUTION', reason: 'only the mandate’s Vercel project may be exported' };
      }
      return { allow: true, estimated_monthly_usd: 0 };
    }

    // Rollback tools: scope-checked here; the gateway additionally confines them to
    // resources this same mandate created.
    case 'hetzner:server.delete':
    case 'cloudflare:dns.rollback': {
      if (!scopeCovers(mandate.scope, toolName)) {
        return { allow: false, code: 'OUT_OF_SCOPE', reason: `mandate scope excludes ${toolName}` };
      }
      return { allow: true, estimated_monthly_usd: 0 };
    }

    case 'anakin:scrape.status':
    case 'coolify:envs.bulk_update':
    case 'coolify:application.deploy':
    case 'coolify:deployment.status':
    case 'coolify:health': {
      if (!scopeCovers(mandate.scope, toolName)) {
        return { allow: false, code: 'OUT_OF_SCOPE', reason: `mandate scope excludes ${toolName}` };
      }
      return { allow: true, estimated_monthly_usd: 0 };
    }

    default:
      // Default-deny. Nasiko's per-agent permissions are default-ALLOW, so the
      // restrictive default has to live here.
      return { allow: false, code: 'UNKNOWN_TOOL', reason: `${toolName} is not a mandate-governed tool` };
  }
}
