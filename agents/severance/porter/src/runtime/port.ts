import fg from 'fast-glob';
import { structuredPatch } from 'diff';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { IndentationText, NewLineKind, Project, QuoteKind } from 'ts-morph';
import { scanRepo } from '../inventory/scan.js';
import type { Finding, LockInInventory } from '../inventory/schema.js';
import { exists, readText, writeText } from '../util/fs.js';
import { log as defaultLog } from '../util/log.js';
import { resolveLayout } from '../transforms/shared.js';
import { TRANSFORMS } from '../transforms/index.js';
import type {
  DepChange,
  EnvVar,
  NewFile,
  PortPlan,
  PortStep,
  PortTarget,
  ProjectLayout,
  TransformContext,
} from '../transforms/types.js';

const SOURCE_GLOB = ['**/*.{ts,tsx,js,jsx,mjs,cjs}'];
const IGNORE = [
  '**/node_modules/**',
  '**/.next/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/.porter/**',
  '**/coverage/**',
];

/** Directories never copied into a dry-run workspace. */
const COPY_SKIP = new Set(['node_modules', '.git', '.next', '.porter', 'coverage']);

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
};

export const defaultTarget: PortTarget = {
  objectStore: 's3',
  redis: 'redis',
  scheduler: 'compose-sidecar',
  standalone: true,
  replicas: 2,
};

export type PortResult = {
  plan: PortPlan;
  /** Git-style unified diff of every file the port creates or edits. Empty when there is nothing to do. */
  diff: string;
  /** Repo-relative paths the port creates or edits. */
  touched: string[];
  /** True when the changes were written to `repoRoot`; false for a dry run. */
  applied: boolean;
};

async function loadProject(repoRoot: string, layout: ProjectLayout): Promise<Project> {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, jsx: 4 },
    manipulationSettings: {
      // Edits should look like the file they land in, not like ts-morph's defaults.
      indentationText:
        layout.indent === 'tab'
          ? IndentationText.Tab
          : layout.indent === 'four'
            ? IndentationText.FourSpaces
            : IndentationText.TwoSpaces,
      newLineKind: layout.crlf ? NewLineKind.CarriageReturnLineFeed : NewLineKind.LineFeed,
      quoteKind: QuoteKind.Single,
      useTrailingCommas: true,
    },
  });

  const files = await fg(SOURCE_GLOB, { cwd: repoRoot, absolute: true, ignore: IGNORE, dot: false });
  for (const file of files) project.addSourceFileAtPath(file);
  return project;
}

/** A plan plus the in-memory project whose source edits it describes. */
type PreparedPort = { plan: PortPlan; project: Project; layout: ProjectLayout };

async function prepare(
  repoRoot: string,
  options: { inventory?: LockInInventory; target?: Partial<PortTarget>; dryRun?: boolean },
): Promise<PreparedPort> {
  const root = resolve(repoRoot);
  const inventory = options.inventory ?? (await scanRepo(root));
  const layout = await resolveLayout(root);
  const project = await loadProject(root, layout);
  const target: PortTarget = { ...defaultTarget, ...options.target };

  const ctx: TransformContext = {
    repoRoot: root,
    inventory,
    project,
    dryRun: Boolean(options.dryRun),
    target,
    layout,
    log: defaultLog.detail,
  };

  const steps: PortStep[] = [];
  const discharged = new Set<string>();

  for (const transform of TRANSFORMS) {
    const findings = inventory.findings.filter((finding) => transform.claims(finding));
    if (findings.length === 0) continue;
    const step = await transform.plan(findings, ctx);
    if (!step) continue;
    steps.push(step);
    for (const id of step.discharges) discharged.add(id);
  }

  return {
    plan: {
      schemaVersion: 1,
      repoRoot: root,
      generatedAt: new Date().toISOString(),
      target,
      steps,
      // A finding is unhandled unless a step says it resolved it. Being claimed by a
      // transform that did nothing about it does not count.
      unhandled: inventory.findings.filter((finding) => !discharged.has(finding.id)),
    },
    project,
    layout,
  };
}

export async function planPort(
  repoRoot: string,
  options: { inventory?: LockInInventory; target?: Partial<PortTarget>; dryRun?: boolean } = {},
): Promise<PortPlan> {
  return (await prepare(repoRoot, options)).plan;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function allDeps(steps: PortStep[]): DepChange[] {
  return steps.flatMap((step) => step.deps);
}

function allEnv(steps: PortStep[]): EnvVar[] {
  const byName = new Map<string, EnvVar>();
  for (const env of steps.flatMap((step) => step.env)) {
    const existing = byName.get(env.name);
    // Two steps may need the same variable; keep it required if either says so.
    byName.set(env.name, existing ? { ...env, required: existing.required || env.required } : env);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function sortKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

async function updatePackageJson(repoRoot: string, steps: PortStep[]): Promise<string | null> {
  const path = resolve(repoRoot, 'package.json');
  const original = await readText(path);
  if (original === null) return null;

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(original) as PackageJson;
  } catch {
    return null;
  }

  const deps = allDeps(steps);
  if (deps.length === 0) return null;

  // Removals win over additions: if one step drops a package another still
  // needs, the second step's requirement is what the code actually imports.
  for (const dep of deps) {
    const bucket = dep.dev ? 'devDependencies' : 'dependencies';
    if (dep.range === null) {
      delete pkg.dependencies?.[dep.name];
      delete pkg.devDependencies?.[dep.name];
      continue;
    }
    pkg[bucket] ??= {};
    (pkg[bucket] as Record<string, string>)[dep.name] = dep.range;
  }

  // npm keeps these alphabetical, so sorting is the file's natural state rather
  // than churn — and it keeps the diff to the lines that changed.
  for (const bucket of ['dependencies', 'devDependencies'] as const) {
    const value = pkg[bucket];
    if (!value) continue;
    if (Object.keys(value).length === 0) delete pkg[bucket];
    else pkg[bucket] = sortKeys(value);
  }

  const indent = /^\t/m.test(original) ? '\t' : /^ {4}\S/m.test(original) && !/^ {2}\S/m.test(original) ? 4 : 2;
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(pkg, null, indent).replace(/\n/g, eol) + eol;
}

function envExample(env: EnvVar[]): string {
  const lines = [
    '# Generated by Porter.',
    '# Copy the values into your real secret manager; do not commit production secrets.',
    '',
  ];
  for (const item of env) {
    lines.push(`# ${item.description}`);
    if (item.replaces) lines.push(`# Replaces: ${item.replaces}`);
    if (!item.required) lines.push('# Optional');
    lines.push(`${item.name}=${item.example}`);
    lines.push('');
  }
  return lines.join('\n');
}

function withEol(text: string, crlf: boolean): string {
  return crlf ? text.replace(/\r?\n/g, '\r\n') : text;
}

async function writeGenerated(repoRoot: string, file: NewFile, crlf: boolean): Promise<void> {
  const path = resolve(repoRoot, file.path);
  if (file.skipIfExists && (await exists(path))) return;
  await writeText(path, withEol(file.contents, crlf));
}

const posix = (path: string) => path.replace(/\\/g, '/');

function touchedFiles(plan: PortPlan): string[] {
  const paths = new Set<string>();
  for (const step of plan.steps) {
    for (const path of step.editedFiles) paths.add(posix(path));
    for (const edit of step.fileEdits ?? []) paths.add(posix(edit.path));
    for (const file of step.newFiles) paths.add(posix(file.path));
  }
  if (allDeps(plan.steps).length > 0) paths.add('package.json');
  if (allEnv(plan.steps).length > 0) paths.add('.env.porter.example');
  return [...paths].sort();
}

/** `null` marks a file that did not exist, so its diff header can say `/dev/null`. */
async function snapshot(repoRoot: string, paths: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const path of paths) out.set(path, await readText(resolve(repoRoot, path)));
  return out;
}

/** A `git apply`-able diff for one file. */
export function fileDiff(path: string, before: string | null, after: string): string {
  if (before === after) return '';
  const oldName = before === null ? '/dev/null' : `a/${path}`;
  const patch = structuredPatch(oldName, `b/${path}`, before ?? '', after, '', '', {
    context: 3,
    stripTrailingCr: true,
  });
  if (patch.hunks.length === 0) return '';

  const out = [`diff --git a/${path} b/${path}`];
  if (before === null) out.push('new file mode 100644');
  out.push(`--- ${oldName}`, `+++ b/${path}`);
  for (const hunk of patch.hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines);
  }
  return out.join('\n') + '\n';
}

async function diffFor(
  repoRoot: string,
  before: Map<string, string | null>,
  paths: string[],
): Promise<string> {
  let diff = '';
  for (const path of paths) {
    const after = await readText(resolve(repoRoot, path));
    if (after === null) continue;
    diff += fileDiff(path, before.get(path) ?? null, after);
  }
  return diff;
}

async function apply(prepared: PreparedPort): Promise<{ diff: string; touched: string[] }> {
  const { plan, project, layout } = prepared;
  const touched = touchedFiles(plan);
  const before = await snapshot(plan.repoRoot, touched);

  for (const step of plan.steps) {
    for (const edit of step.fileEdits ?? []) {
      await writeText(resolve(plan.repoRoot, edit.path), withEol(edit.contents, layout.crlf));
    }
    for (const file of step.newFiles) await writeGenerated(plan.repoRoot, file, layout.crlf);
  }

  const pkgText = await updatePackageJson(plan.repoRoot, plan.steps);
  if (pkgText !== null) await writeText(resolve(plan.repoRoot, 'package.json'), pkgText);

  const env = allEnv(plan.steps);
  if (env.length > 0) {
    await writeText(resolve(plan.repoRoot, '.env.porter.example'), withEol(envExample(env), layout.crlf));
  }

  // The same project the transforms edited, so what is saved is exactly what was planned.
  await project.save();

  return { diff: await diffFor(plan.repoRoot, before, touched), touched };
}

/**
 * Apply a plan to disk.
 *
 * The plan is recomputed from the repo rather than replayed: a plan is a
 * description of what Porter would do, and source edits live in an in-memory
 * project that a serialised plan cannot carry.
 */
export async function applyPort(plan: PortPlan): Promise<{ diff: string; touched: string[] }> {
  return apply(await prepare(plan.repoRoot, { target: plan.target }));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderPlanMarkdown(plan: PortPlan): string {
  const lines = [
    `# Porter plan`,
    '',
    `Target: ${plan.target.objectStore} object storage, ${plan.target.redis}, ${plan.target.scheduler} scheduler, ${plan.target.replicas} replica(s)`,
    '',
  ];

  if (plan.steps.length === 0) {
    lines.push('Nothing to port: no Vercel lock-in Porter knows how to rewrite was found.', '');
  } else {
    lines.push(`## Steps (${plan.steps.length})`, '');
  }

  plan.steps.forEach((step, index) => {
    lines.push(`### ${index + 1}. ${step.title}`, '', step.rationale, '');
    if (step.editedFiles.length) lines.push(`Edited: ${step.editedFiles.join(', ')}`, '');
    if (step.newFiles.length) lines.push(`New: ${step.newFiles.map((f) => f.path).join(', ')}`, '');
    if (step.caveats.length) {
      lines.push('Caveats:');
      for (const caveat of step.caveats) lines.push(`- ${caveat}`);
      lines.push('');
    }
  });

  if (plan.unhandled.length > 0) {
    lines.push('## Needs a human', '', 'Porter found these but cannot rewrite them safely:', '');
    for (const finding of plan.unhandled) {
      const where = finding.evidence[0]?.file ?? '';
      lines.push(`- **${finding.title}** (${finding.kind}, ${finding.blast}) — \`${where}\``);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function writePlanArtifacts(
  repoRoot: string,
  plan: PortPlan,
  diff: string,
): Promise<void> {
  const outDir = resolve(repoRoot, '.porter');
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', 'utf8');
  await writeFile(resolve(outDir, 'plan.md'), renderPlanMarkdown(plan), 'utf8');
  await writeFile(resolve(outDir, 'porter.diff'), diff, 'utf8');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function copyRepo(source: string): Promise<string> {
  const dest = await mkdtemp(join(tmpdir(), 'porter-dry-'));
  await cp(source, dest, {
    recursive: true,
    filter: (path) => {
      const name = path.split(/[\\/]/).pop() ?? '';
      return !COPY_SKIP.has(name);
    },
  });
  return dest;
}

/**
 * Port a repo.
 *
 * A dry run does the real work — every transform, every write, a real diff — on
 * a throwaway copy, so what it reports is exactly what a real run would do and
 * the repo is never touched.
 */
export async function portRepo(
  repoRoot: string,
  options: { target?: Partial<PortTarget>; dryRun?: boolean; writeArtifacts?: boolean } = {},
): Promise<PortResult> {
  const root = resolve(repoRoot);

  if (options.dryRun) {
    const scratch = await copyRepo(root);
    try {
      const prepared = await prepare(scratch, { target: options.target, dryRun: true });
      const { diff, touched } = await apply(prepared);
      // Report the plan against the real repo, not the throwaway copy.
      return { plan: { ...prepared.plan, repoRoot: root }, diff, touched, applied: false };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  const prepared = await prepare(root, { target: options.target });
  const { diff, touched } = await apply(prepared);
  if (options.writeArtifacts !== false) await writePlanArtifacts(root, prepared.plan, diff);
  return { plan: prepared.plan, diff, touched, applied: true };
}

export function findingsByKind(findings: Finding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const finding of findings) out[finding.kind] = (out[finding.kind] ?? 0) + 1;
  return out;
}
