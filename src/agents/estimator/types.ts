export type MetricKey =
  | 'activeCpuHours'
  | 'provisionedMemoryGbHours'
  | 'functionDurationGbHours' // legacy, pre-Fluid billing
  | 'invocations'
  | 'fastDataTransferGb'
  | 'fastOriginTransferGb'
  | 'edgeRequests'
  | 'imageTransformations'
  | 'imageCacheReads'
  | 'imageCacheWrites';

/** One line of the FOCUS v1.3 JSONL stream from GET /v1/billing/charges. */
export interface FocusRow {
  ChargeCategory: string;
  ChargePeriodStart: string;
  ChargePeriodEnd: string;
  ConsumedQuantity: number | null;
  ConsumedUnit: string | null;
  EffectiveCost: number;
  ServiceName: string;
  RegionId?: string;
  Tags?: Record<string, string> | string;
}

export interface MetricTotals {
  quantity: number;
  effectiveCost: number;
  /** Highest single-day quantity in the window. */
  peakDayQuantity: number;
  /** Number of distinct days that had usage. */
  activeDays: number;
}

export interface UnclassifiedUsage {
  service: string;
  unit: string | null;
  quantity: number;
  effectiveCost: number;
}

export interface UsageSummary {
  window: { from: string; to: string; days: number };
  metrics: Partial<Record<MetricKey, MetricTotals>>;
  /** Usage rows whose ServiceName we do not recognise. Never silently dropped. */
  unclassified: UnclassifiedUsage[];
  /** Distinct (ServiceName, ConsumedUnit) pairs seen, for verifying the classifier. */
  seenServices: { service: string; unit: string | null }[];
  warnings: string[];
}

export interface VercelProject {
  id: string;
  name: string;
  framework?: string | null;
  nodeVersion?: string;
  rootDirectory?: string | null;
  buildCommand?: string | null;
  installCommand?: string | null;
  serverlessFunctionRegion?: string;
  link?: { type?: string; org?: string; repo?: string; productionBranch?: string };
  resourceConfig?: {
    fluid?: boolean;
    functionDefaultMemoryType?: string;
    functionDefaultTimeout?: number;
    functionDefaultRegions?: string[];
    buildMachineType?: string;
  };
}

export interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
}

export interface WorkloadSignal {
  id: string;
  /** Package or file that triggered the signal. */
  evidence: string;
  addsMemoryMb: number;
  cpuHeavy: boolean;
  note: string;
}

export interface WorkloadProfile {
  framework: string | null;
  frameworkMajor: number | null;
  baselineMemoryMb: number;
  signals: WorkloadSignal[];
  /** baseline + signals, before headroom. */
  estimatedPeakMemoryMb: number;
  cpuHeavy: boolean;
  buildNotes: string[];
}

export type Confidence = 'low' | 'medium' | 'high';

export interface ResourceRecommendation {
  current: { memoryGb: number; vcpu: number; source: 'project-setting' | 'assumed-default' };
  observed: {
    avgActiveCpuMsPerInvocation: number | null;
    /** Average number of busy function instances on the peak day. */
    peakDayAvgInstances: number | null;
    /** Function invocations per edge request; high means SSR/API heavy. */
    invocationsPerEdgeRequest: number | null;
  };
  vercel: { tier: 'standard' | 'performance'; memoryGb: number; vcpu: number };
  /** Capacity for a dedicated host serving the same traffic. Heuristic. */
  selfHost: { vcpu: number; memoryGb: number } | null;
  /** Cost delta if the recommended tier differs from current, from observed $/unit. */
  whatIf: { monthlyCostDeltaUsd: number; basis: string } | null;
  rationale: string[];
  confidence: Confidence;
}

export interface EstimatorReport {
  generatedAt: string;
  project: { id: string; name: string; region?: string; fluid?: boolean };
  usage: UsageSummary;
  workload: WorkloadProfile | null;
  recommendation: ResourceRecommendation;
  warnings: string[];
}
