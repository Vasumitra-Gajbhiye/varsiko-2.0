import type {
  Confidence,
  ResourceRecommendation,
  UsageSummary,
  VercelProject,
  WorkloadProfile,
} from './types.ts';

/** Vercel's only two Function sizes (docs: configuring-functions/memory). */
const TIERS = {
  standard: { memoryGb: 2, vcpu: 1 },
  performance: { memoryGb: 4, vcpu: 2 },
} as const;

// Tunable heuristics. Kept as named constants so they are easy to audit and change.
const MEMORY_HEADROOM = 1.25; // margin over estimated peak process memory
const STANDARD_MEMORY_BUDGET_FRACTION = 0.75; // don't plan to run Standard above 75% of 2 GB
const CPU_HEAVY_MS_PER_INVOCATION = 150; // avg Active CPU per invocation that signals CPU-bound work
const PEAK_HOUR_OVER_DAY_AVERAGE = 3; // burstiness applied when sizing a dedicated host
const HOST_HEADROOM = 1.3;

function currentTier(project?: VercelProject): ResourceRecommendation['current'] {
  const type = project?.resourceConfig?.functionDefaultMemoryType;
  if (type === 'performance') return { ...TIERS.performance, source: 'project-setting' };
  if (type === 'standard') return { ...TIERS.standard, source: 'project-setting' };
  return { ...TIERS.standard, source: 'assumed-default' };
}

export function recommend(input: {
  usage: UsageSummary;
  workload: WorkloadProfile | null;
  project?: VercelProject;
}): ResourceRecommendation {
  const { usage, workload, project } = input;
  const m = usage.metrics;
  const current = currentTier(project);
  const rationale: string[] = [];

  // ---- observed, from billing ------------------------------------------------
  const invocations = m.invocations?.quantity ?? 0;
  const activeCpuHours = m.activeCpuHours?.quantity;
  const memoryMetric = m.provisionedMemoryGbHours ?? m.functionDurationGbHours;
  const edgeRequests = m.edgeRequests?.quantity ?? 0;

  const avgActiveCpuMsPerInvocation =
    activeCpuHours !== undefined && invocations > 0 ? (activeCpuHours * 3_600_000) / invocations : null;
  const peakDayAvgInstances = memoryMetric ? memoryMetric.peakDayQuantity / current.memoryGb / 24 : null;
  const invocationsPerEdgeRequest = invocations > 0 && edgeRequests > 0 ? invocations / edgeRequests : null;

  if (current.source === 'assumed-default') {
    rationale.push('Project does not report a default Function size; assuming Standard (2 GB / 1 vCPU).');
  }

  // ---- decide tier -------------------------------------------------------------
  const requiredMb = workload ? Math.ceil(workload.estimatedPeakMemoryMb * MEMORY_HEADROOM) : null;
  const budgetMb = TIERS.standard.memoryGb * 1024 * STANDARD_MEMORY_BUDGET_FRACTION;
  const runtimeCpuHeavy =
    avgActiveCpuMsPerInvocation !== null && avgActiveCpuMsPerInvocation > CPU_HEAVY_MS_PER_INVOCATION;

  let tier: 'standard' | 'performance' = 'standard';
  if (requiredMb !== null && requiredMb > budgetMb) {
    tier = 'performance';
    const drivers = workload!.signals.filter((s) => s.addsMemoryMb > 0).map((s) => `${s.evidence} (+${s.addsMemoryMb} MB)`);
    rationale.push(
      `Estimated peak memory ${requiredMb} MB (incl. ${Math.round((MEMORY_HEADROOM - 1) * 100)}% headroom) exceeds ` +
        `${Math.round(budgetMb)} MB, the Standard budget. Drivers: ${workload!.baselineMemoryMb} MB ${workload!.framework ?? 'node'} baseline` +
        `${drivers.length ? ', ' + drivers.join(', ') : ''}.`,
    );
  }
  if (runtimeCpuHeavy) {
    tier = 'performance';
    rationale.push(
      `Observed ${avgActiveCpuMsPerInvocation!.toFixed(0)} ms Active CPU per invocation, above the ${CPU_HEAVY_MS_PER_INVOCATION} ms CPU-bound threshold; a second vCPU should cut latency.`,
    );
  } else if (workload?.cpuHeavy && avgActiveCpuMsPerInvocation === null) {
    tier = 'performance';
    rationale.push('CPU-heavy dependencies found and no Active CPU billing data to confirm otherwise.');
  } else if (workload?.cpuHeavy && avgActiveCpuMsPerInvocation !== null) {
    rationale.push(
      `CPU-heavy dependencies found, but observed Active CPU is only ${avgActiveCpuMsPerInvocation.toFixed(0)} ms per invocation, so they are not dominating traffic.`,
    );
  }
  if (tier === 'standard') {
    rationale.push('Workload fits Standard (2 GB / 1 vCPU); Performance would double provisioned-memory spend without evidence of need.');
  }
  if (invocationsPerEdgeRequest !== null) {
    rationale.push(
      `${(invocationsPerEdgeRequest * 100).toFixed(0)}% as many function invocations as edge requests: ` +
        (invocationsPerEdgeRequest > 0.5 ? 'SSR/API-heavy traffic.' : 'mostly cache or static hits.'),
    );
  }
  for (const s of workload?.signals.filter((x) => x.id === 'io-bound-ai') ?? []) {
    rationale.push(s.note);
  }

  const vercel = { tier, ...TIERS[tier] };

  // ---- dedicated-host equivalent -------------------------------------------------
  let selfHost: ResourceRecommendation['selfHost'] = null;
  const peakDayBusyVcpus =
    m.activeCpuHours !== undefined
      ? m.activeCpuHours.peakDayQuantity / 24
      : peakDayAvgInstances !== null
        ? peakDayAvgInstances * current.vcpu // upper bound: assumes instances are CPU-busy
        : null;
  if (peakDayBusyVcpus !== null) {
    const vcpu = Math.max(1, Math.ceil(peakDayBusyVcpus * PEAK_HOUR_OVER_DAY_AVERAGE * HOST_HEADROOM));
    const perProcessMb = requiredMb ?? 1024;
    selfHost = { vcpu, memoryGb: Math.max(1, Math.ceil(((vcpu * perProcessMb) / 1024) * 2) / 2) };
    rationale.push(
      `Dedicated-host equivalent: peak day averages ${peakDayBusyVcpus.toFixed(2)} busy vCPUs; ×${PEAK_HOUR_OVER_DAY_AVERAGE} for peak-hour burst, ×${HOST_HEADROOM} headroom, one process per vCPU at ${perProcessMb} MB.`,
    );
  }

  // ---- what-if cost --------------------------------------------------------------
  let whatIf: ResourceRecommendation['whatIf'] = null;
  const provisioned = m.provisionedMemoryGbHours;
  if (provisioned && provisioned.effectiveCost > 0 && vercel.memoryGb !== current.memoryGb) {
    const scaled = provisioned.effectiveCost * (vercel.memoryGb / current.memoryGb);
    const perMonth = 30 / usage.window.days;
    whatIf = {
      monthlyCostDeltaUsd: Number(((scaled - provisioned.effectiveCost) * perMonth).toFixed(2)),
      basis:
        `Provisioned Memory scales linearly with size (${current.memoryGb} GB -> ${vercel.memoryGb} GB); Active CPU held constant (conservative). ` +
        `Based on $${provisioned.effectiveCost.toFixed(2)} observed over ${usage.window.days} days.`,
    };
  }

  // ---- confidence ----------------------------------------------------------------
  const haveUsage = invocations > 0 && (activeCpuHours !== undefined || memoryMetric !== undefined);
  const confidence: Confidence = haveUsage && workload ? 'high' : haveUsage || workload ? 'medium' : 'low';
  if (!haveUsage) rationale.push('No usable function billing data: recommendation rests on package.json heuristics alone.');
  if (!workload) rationale.push('No package.json available: recommendation rests on billing data alone.');

  return {
    current,
    observed: { avgActiveCpuMsPerInvocation, peakDayAvgInstances, invocationsPerEdgeRequest },
    vercel,
    selfHost,
    whatIf,
    rationale,
    confidence,
  };
}
