import type { Finding, LockInInventory, LockInKind } from '../inventory/schema.js';
import type { Project } from 'ts-morph';

/**
 * One file Porter writes into the target repo that did not exist before —
 * a shim, a worker, a cache handler. Kept separate from edits so the PR body
 * can list "new files" and "modified files" the way a reviewer expects.
 */
export type NewFile = {
  path: string;
  contents: string;
  /** Skip if the file already exists (idempotency). */
  skipIfExists?: boolean;
};

/** A whole-file replacement for an existing file such as package.json or vercel.json. */
export type FileEdit = {
  path: string;
  contents: string;
};

/** A dependency change Porter makes to package.json. */
export type DepChange = {
  name: string;
  /** null removes it. */
  range: string | null;
  dev?: boolean;
  /** Shown in the PR body next to the dep. */
  reason: string;
};

/** An env var the ported app now needs. Lands in .env.porter.example. */
export type EnvVar = {
  name: string;
  example: string;
  required: boolean;
  description: string;
  /** The Vercel-managed var it replaces, if any. */
  replaces?: string;
};

/**
 * A single, reviewable unit of change. One step == one bullet in the PR body
 * and one collapsible section in the console. Steps are ordered and each one
 * names the finding it discharges, so no change in the diff is unexplained.
 */
export type PortStep = {
  id: string;
  kind: LockInKind;
  /** Imperative, present tense: "Route next/image through a local sharp loader". */
  title: string;
  /** The reviewer-facing justification. Markdown, 1-3 sentences. */
  rationale: string;
  /**
   * Finding ids this step actually resolved. A transform must not list a
   * finding here unless its change fixes that finding — anything left out is
   * reported as unhandled, which is the honest outcome.
   */
  discharges: string[];
  editedFiles: string[];
  /** Whole-file edits for files that are not represented as ts-morph source files. */
  fileEdits?: FileEdit[];
  newFiles: NewFile[];
  deps: DepChange[];
  env: EnvVar[];
  /** Manual follow-ups Porter cannot do. Surfaced loudly, never silently dropped. */
  caveats: string[];
};

/**
 * Where Porter-generated modules live and how call sites import them.
 *
 * A repo with `src/app` and `@/* -> ./src/*` needs its shims under `src/lib`,
 * and a repo with no alias needs relative imports. Hardcoding `@/lib/porter`
 * produces a build that cannot resolve its own imports.
 */
export type ProjectLayout = {
  /** Repo-relative directory holding `app/` or `pages/`: '' or 'src'. */
  srcRoot: '' | 'src';
  /** Repo-relative app-router directory (`app` or `src/app`), or null for pages-only repos. */
  appDir: string | null;
  /** Repo-relative directory `@/*` resolves to ('' or 'src'), or null when the alias is absent. */
  aliasRoot: string | null;
  /** Repo-relative directory generated shims are written to. */
  libDir: string;
  /** Whether source files use CRLF line endings. */
  crlf: boolean;
  /** Indentation the repo's config files use. */
  indent: 'two' | 'four' | 'tab';
};

export type TransformContext = {
  repoRoot: string;
  inventory: LockInInventory;
  /** Shared ts-morph project; transforms mutate source files in memory. */
  project: Project;
  /** When true, transforms compute steps but must not touch the filesystem. */
  dryRun: boolean;
  /** Target infrastructure the Pilot will provision. Shapes generated config. */
  target: PortTarget;
  layout: ProjectLayout;
  log: (msg: string) => void;
};

/**
 * What the app is being ported *to*. Porter generates different shims for
 * different backing services, so this is an input, not an assumption.
 */
export type PortTarget = {
  /** S3-compatible object storage for the blob transform. */
  objectStore: 's3' | 'minio' | 'r2' | 'b2' | 'hetzner';
  /** Redis for KV and the ISR cache handler. */
  redis: 'redis' | 'valkey' | 'dragonfly';
  /** Where cron lands. */
  scheduler: 'coolify' | 'node-cron' | 'system-crontab' | 'compose-sidecar';
  /** Whether the Dockerfile targets `output: 'standalone'`. */
  standalone: boolean;
  /** Number of app replicas. >1 forces a shared ISR cache. */
  replicas: number;
};

export interface Transform {
  /** Stable id, matches the module name. */
  readonly id: string;
  readonly kind: LockInKind;
  /** One line for the console and the PR table of contents. */
  readonly summary: string;
  /** Which findings this transform claims. */
  claims(finding: Finding): boolean;
  /**
   * Compute the change. Must be pure with respect to the filesystem when
   * ctx.dryRun is true, and idempotent: running it on already-ported code
   * returns null rather than double-applying.
   */
  plan(findings: Finding[], ctx: TransformContext): Promise<PortStep | null>;
}

export type PortPlan = {
  schemaVersion: 1;
  repoRoot: string;
  generatedAt: string;
  target: PortTarget;
  steps: PortStep[];
  /** Findings no transform discharged. Reported, never hidden. */
  unhandled: Finding[];
};
