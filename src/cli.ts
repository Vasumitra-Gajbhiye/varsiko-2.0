import { parseArgs } from 'node:util';
import { estimate, VercelReadOnlyClient } from './agents/estimator/index.ts';
import type { EstimatorReport, MetricKey } from './agents/estimator/index.ts';

const USAGE = `Usage: npm run estimate -- --project <name|id> [options]

  --project <name|id>     Vercel project to analyse (required)
  --days <n>              Trailing window, 1-365 (default 30)
  --package-json <path>   Read package.json locally instead of from GitHub
  --json                  Emit the full report as JSON
  --dump-services         Also list every billing ServiceName/unit seen (to verify the classifier)

Environment: VERCEL_TOKEN (required), VERCEL_TEAM_ID, GITHUB_TOKEN`;

const LABELS: Record<MetricKey, [string, string]> = {
  activeCpuHours: ['Active CPU', 'h'],
  provisionedMemoryGbHours: ['Provisioned Memory', 'GB-h'],
  functionDurationGbHours: ['Function Duration (legacy)', 'GB-h'],
  invocations: ['Function Invocations', ''],
  fastDataTransferGb: ['Fast Data Transfer', 'GB'],
  fastOriginTransferGb: ['Fast Origin Transfer', 'GB'],
  edgeRequests: ['Edge Requests', ''],
  imageTransformations: ['Image Transformations', ''],
  imageCacheReads: ['Image Cache Reads', ''],
  imageCacheWrites: ['Image Cache Writes', ''],
};

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 2 : 0 });

function render(r: EstimatorReport, dumpServices: boolean): string {
  const out: string[] = [];
  const rec = r.recommendation;
  out.push(`Project ${r.project.name} (${r.project.id})  region ${r.project.region ?? '?'}  fluid ${r.project.fluid ?? '?'}`);
  out.push(`Window ${r.usage.window.from.slice(0, 10)} -> ${r.usage.window.to.slice(0, 10)} (${r.usage.window.days} days)`);
  out.push('', 'Usage');
  const entries = Object.entries(r.usage.metrics) as [MetricKey, NonNullable<EstimatorReport['usage']['metrics'][MetricKey]>][];
  if (!entries.length) out.push('  (none)');
  for (const [k, v] of entries) {
    const [label, unit] = LABELS[k];
    out.push(`  ${label.padEnd(28)} ${fmt(v.quantity).padStart(14)} ${unit.padEnd(5)} $${v.effectiveCost.toFixed(2).padStart(9)}   peak day ${fmt(v.peakDayQuantity)}`);
  }
  if (r.workload) {
    const w = r.workload;
    out.push('', `Workload  ${w.framework ?? 'unknown framework'}${w.frameworkMajor ? ' ' + w.frameworkMajor : ''}, ~${w.estimatedPeakMemoryMb} MB peak (heuristic)`);
    for (const s of w.signals) out.push(`  - ${s.evidence}: ${s.note}`);
    for (const n of w.buildNotes) out.push(`  ! ${n}`);
  }
  out.push('', `Recommendation  (confidence: ${rec.confidence})`);
  out.push(`  Current   ${rec.current.memoryGb} GB / ${rec.current.vcpu} vCPU (${rec.current.source})`);
  out.push(`  Vercel    ${rec.vercel.tier}: ${rec.vercel.memoryGb} GB / ${rec.vercel.vcpu} vCPU`);
  if (rec.selfHost) out.push(`  Dedicated ${rec.selfHost.vcpu} vCPU / ${rec.selfHost.memoryGb} GB RAM`);
  if (rec.whatIf) out.push(`  Cost      ${rec.whatIf.monthlyCostDeltaUsd >= 0 ? '+' : '-'}$${Math.abs(rec.whatIf.monthlyCostDeltaUsd).toFixed(2)}/mo  (${rec.whatIf.basis})`);
  out.push('  Why');
  for (const line of rec.rationale) out.push(`    - ${line}`);
  if (r.warnings.length) {
    out.push('', 'Warnings');
    for (const w of r.warnings) out.push(`  ! ${w}`);
  }
  if (dumpServices) {
    out.push('', 'Billing services seen');
    for (const s of r.usage.seenServices) out.push(`  ${s.service}  [${s.unit}]`);
  }
  return out.join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      days: { type: 'string', default: '30' },
      'package-json': { type: 'string' },
      json: { type: 'boolean', default: false },
      'dump-services': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || !values.project) {
    console.error(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    console.error('VERCEL_TOKEN is not set. Create a team-scoped token at https://vercel.com/account/tokens.');
    process.exit(2);
  }

  const client = new VercelReadOnlyClient({ token, teamId: process.env.VERCEL_TEAM_ID });
  const report = await estimate({
    client,
    project: values.project,
    days: Number(values.days),
    packageJsonPath: values['package-json'],
    githubToken: process.env.GITHUB_TOKEN,
  });
  console.log(values.json ? JSON.stringify(report, null, 2) : render(report, values['dump-services']));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
