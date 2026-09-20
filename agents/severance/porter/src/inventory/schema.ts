/**
 * Porter's own inventory shape (findings[].kind / blast / confidence).
 *
 * Surveyor (agent 01) emits a different contract — severance.capacity_spec/v1
 * with lockin_detail[] (feature, severity, evidence.file/line/rule/match,
 * porter_hint). Those are related but NOT identical. Porter always re-scans
 * the repo with ./scan.ts; Surveyor's lockin_detail is advisory context only.
 */

/** Every kind of platform coupling Porter knows how to rewrite. */
export const LOCK_IN_KINDS = [
  'image-optimization',
  'blob-storage',
  'kv-store',
  'cron',
  'edge-middleware',
  'edge-runtime',
  'isr',
  'platform-sdk',
  'build-output',
] as const;

export type LockInKind = (typeof LOCK_IN_KINDS)[number];

/**
 * What happens off-platform if this finding is left alone.
 *
 * The distinction matters because `silent-drift` is the class that makes
 * migrations fail two weeks later instead of at build time, and it is the
 * class a human reviewer most needs pointed out.
 */
export type Blast =
  /** The build will not complete. */
  | 'build-break'
  /** The build completes; the route throws at runtime. */
  | 'runtime-break'
  /** It runs, but behaviour quietly differs (stale cache, lost geo, no metrics). */
  | 'silent-drift'
  /** Cosmetic or dead weight; safe to leave, nice to remove. */
  | 'cosmetic';

export type Evidence = {
  /** Repo-relative, POSIX separators. */
  file: string;
  /** 1-indexed. Absent for whole-file or config-key findings. */
  line?: number;
  /** The matched source text, trimmed to one line. */
  snippet: string;
  /** What matched: an import specifier, a config key, an export name. */
  matched: string;
};

export type Finding = {
  /** Stable across runs: `${kind}:${file}:${matched}`. Used for idempotency. */
  id: string;
  kind: LockInKind;
  blast: Blast;
  /** One line, written for a human reading a PR. */
  title: string;
  /** Why this breaks off-platform. Ends up verbatim in the PR body. */
  why: string;
  evidence: Evidence[];
  /** 0..1. Below 0.6 Porter proposes but does not auto-apply. */
  confidence: number;
};

export type DetectedFramework = {
  name: 'next';
  /** As declared in package.json, e.g. "15.1.0". */
  version: string;
  major: number;
  router: 'app' | 'pages' | 'hybrid';
  /** `output` in next.config, if set. */
  output?: 'standalone' | 'export' | undefined;
  configPath?: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
};

export type LockInInventory = {
  schemaVersion: 1;
  /** Absolute path to the repo Porter is rewriting. */
  repoRoot: string;
  generatedAt: string;
  /** 'surveyor' when handed over A2A, 'porter-scan' when Porter built it itself. */
  source: 'surveyor' | 'porter-scan';
  framework: DetectedFramework;
  findings: Finding[];
  /** Vercel-namespaced deps found in package.json, name -> range. */
  platformDependencies: Record<string, string>;
};

/** Counts by blast radius — what the PR body leads with. */
export function summarize(inv: LockInInventory) {
  const byKind = new Map<LockInKind, number>();
  const byBlast = new Map<Blast, number>();
  for (const f of inv.findings) {
    byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
    byBlast.set(f.blast, (byBlast.get(f.blast) ?? 0) + 1);
  }
  return {
    total: inv.findings.length,
    kinds: [...byKind.entries()].map(([kind, count]) => ({ kind, count })),
    blast: [...byBlast.entries()].map(([blast, count]) => ({ blast, count })),
    wouldBreakBuild: inv.findings.filter((f) => f.blast === 'build-break').length,
    wouldDriftSilently: inv.findings.filter((f) => f.blast === 'silent-drift').length,
  };
}

export function findingId(kind: LockInKind, file: string, matched: string): string {
  return `${kind}:${file}:${matched}`;
}
