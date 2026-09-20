import { readJsonl, summarizeCharges } from './billing.ts';
import { analyzeManifest } from './manifest.ts';
import { recommend } from './sizing.ts';
import { loadPackageJson } from './source.ts';
import type { EstimatorReport } from './types.ts';
import { VercelReadOnlyClient } from './vercel-client.ts';

export interface EstimateOptions {
  client: VercelReadOnlyClient;
  project: string;
  /** Trailing window in days (billing API supports up to 1 year). */
  days?: number;
  packageJsonPath?: string;
  githubToken?: string;
  now?: Date;
}

/** Agent 1: pulls real usage from Vercel, inspects package.json, returns a sizing report. */
export async function estimate(opts: EstimateOptions): Promise<EstimatorReport> {
  const days = opts.days ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('days must be an integer from 1 to 365');

  const now = opts.now ?? new Date();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); // today 00:00Z, exclusive
  const from = new Date(to.getTime() - days * 86_400_000);
  const warnings: string[] = [];

  const project = await opts.client.findProject(opts.project);

  const [usage, pkgResult] = await Promise.all([
    opts.client
      .billingCharges(from.toISOString(), to.toISOString())
      .then((body) =>
        summarizeCharges(readJsonl(body), {
          from: from.toISOString(),
          to: to.toISOString(),
          project: { id: project.id, name: project.name },
        }),
      ),
    loadPackageJson({ localPath: opts.packageJsonPath, project, githubToken: opts.githubToken }),
  ]);

  let workload = null;
  if (pkgResult.pkg) {
    workload = analyzeManifest(pkgResult.pkg, project);
  } else {
    warnings.push(pkgResult.reason);
  }
  warnings.push(...usage.warnings);
  if (usage.unclassified.length) {
    warnings.push(
      `${usage.unclassified.length} billing line(s) were not recognised and are excluded from sizing: ` +
        usage.unclassified.map((u) => u.service).join(', '),
    );
  }

  return {
    generatedAt: now.toISOString(),
    project: {
      id: project.id,
      name: project.name,
      region: project.serverlessFunctionRegion,
      fluid: project.resourceConfig?.fluid,
    },
    usage,
    workload,
    recommendation: recommend({ usage, workload, project }),
    warnings,
  };
}

export { VercelReadOnlyClient } from './vercel-client.ts';
export type * from './types.ts';
