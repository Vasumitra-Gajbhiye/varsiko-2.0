import fg from 'fast-glob';
import { resolve } from 'node:path';
import { Project, SyntaxKind, type SourceFile } from 'ts-morph';
import { IMPORT_RULES, CONFIG_RULES, type ImportRule } from './rules.js';
import {
  findingId,
  type DetectedFramework,
  type Finding,
  type LockInInventory,
} from './schema.js';
import { exists, readJson, readText, rel } from '../util/fs.js';

const SOURCE_GLOB = ['**/*.{ts,tsx,js,jsx,mjs,cjs}'];
const IGNORE = [
  '**/node_modules/**',
  '**/.next/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/coverage/**',
];

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
};

/**
 * Build a LockInInventory from a repo on disk.
 *
 * This duplicates what Surveyor does from the live Vercel API, on purpose:
 * Surveyor sees runtime truth (what the project is actually billed for),
 * Porter sees source truth (what the code actually calls). When both run, the
 * union is stronger than either. When Surveyor is down, Porter still ports.
 */
export async function scanRepo(repoRoot: string): Promise<LockInInventory> {
  const root = resolve(repoRoot);
  const pkg = (await readJson<PackageJson>(resolve(root, 'package.json'))) ?? {};
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };

  const framework = await detectFramework(root, pkg, deps);
  const findings: Finding[] = [];

  const files = await fg(SOURCE_GLOB, { cwd: root, ignore: IGNORE, absolute: true, dot: false });

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, jsx: 4 },
  });

  for (const file of files) {
    const source = project.addSourceFileAtPath(file);
    findings.push(...scanImports(root, source));
    findings.push(...scanRuntimeExports(root, source));
    findings.push(...scanIsr(root, source));
  }

  findings.push(...(await scanVercelJson(root)));
  findings.push(...(await scanNextConfig(root, framework, deps)));
  findings.push(...(await scanMiddleware(root)));
  findings.push(...(await scanBuildOutput(root, framework, pkg, deps)));

  // A cache handler in next.config is what resolves the ISR finding. Without
  // this gate the finding survives its own fix and a re-scan never comes back
  // clean, which makes "is this repo already ported?" unanswerable.
  const configText = framework.configPath ? await readText(resolve(root, framework.configPath)) : null;
  const hasCacheHandler = configText !== null && /\bcacheHandler\s*:/.test(configText);
  const resolved = hasCacheHandler ? findings.filter((f) => f.kind !== 'isr') : [...findings];

  const platformDependencies: Record<string, string> = {};
  for (const [name, range] of Object.entries(deps)) {
    if (name.startsWith('@vercel/')) platformDependencies[name] = range;
  }

  return {
    schemaVersion: 1,
    repoRoot: root,
    generatedAt: new Date().toISOString(),
    source: 'porter-scan',
    framework,
    findings: dedupe(resolved),
    platformDependencies,
  };
}

async function detectFramework(
  root: string,
  pkg: PackageJson,
  deps: Record<string, string>,
): Promise<DetectedFramework> {
  const version = deps['next'] ?? '0.0.0';
  const major = Number.parseInt(version.replace(/^[^\d]*/, ''), 10) || 0;

  const hasApp = (await exists(resolve(root, 'app'))) || (await exists(resolve(root, 'src/app')));
  const hasPages =
    (await exists(resolve(root, 'pages'))) || (await exists(resolve(root, 'src/pages')));

  let configPath: string | undefined;
  for (const name of ['next.config.mjs', 'next.config.js', 'next.config.ts', 'next.config.cjs']) {
    if (await exists(resolve(root, name))) {
      configPath = name;
      break;
    }
  }

  const configText = configPath ? await readText(resolve(root, configPath)) : null;
  const outputMatch = configText ? /output\s*:\s*["'](standalone|export)["']/.exec(configText) : null;

  let packageManager: DetectedFramework['packageManager'] = 'npm';
  if (pkg.packageManager?.startsWith('pnpm')) packageManager = 'pnpm';
  else if (pkg.packageManager?.startsWith('yarn')) packageManager = 'yarn';
  else if (await exists(resolve(root, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
  else if (await exists(resolve(root, 'yarn.lock'))) packageManager = 'yarn';
  else if (await exists(resolve(root, 'bun.lockb'))) packageManager = 'bun';

  return {
    name: 'next',
    version,
    major,
    router: hasApp && hasPages ? 'hybrid' : hasPages ? 'pages' : 'app',
    output: outputMatch ? (outputMatch[1] as DetectedFramework['output']) : undefined,
    configPath,
    packageManager,
  };
}

function matchImportRule(specifier: string): ImportRule | undefined {
  return IMPORT_RULES.find((rule) =>
    rule.prefix
      ? specifier === rule.specifier || specifier.startsWith(rule.specifier + '/')
      : specifier === rule.specifier,
  );
}

function firstLine(text: string): string {
  const line = text.split('\n')[0];
  return line ? line.trim() : text.trim();
}

function scanImports(root: string, source: SourceFile): Finding[] {
  const out: Finding[] = [];
  const file = rel(root, source.getFilePath());

  const specifiers: { text: string; line: number; snippet: string }[] = [];

  for (const decl of source.getImportDeclarations()) {
    specifiers.push({
      text: decl.getModuleSpecifierValue(),
      line: decl.getStartLineNumber(),
      snippet: firstLine(decl.getText()),
    });
  }

  // `require()` and dynamic `import()` both matter. A migration that only reads
  // static imports misses the CommonJS half of most real codebases, and misses
  // lazily-imported platform SDKs entirely.
  for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const isRequire = expr.getText() === 'require';
    const isDynamic = expr.getKind() === SyntaxKind.ImportKeyword;
    if (!isRequire && !isDynamic) continue;
    const arg = call.getArguments()[0];
    if (!arg || !arg.isKind(SyntaxKind.StringLiteral)) continue;
    specifiers.push({
      text: arg.getLiteralValue(),
      line: call.getStartLineNumber(),
      snippet: firstLine(call.getText()),
    });
  }

  for (const spec of specifiers) {
    const rule = matchImportRule(spec.text);
    if (!rule) continue;
    out.push({
      id: findingId(rule.kind, file, spec.text),
      kind: rule.kind,
      blast: rule.blast,
      title: rule.title,
      why: rule.why,
      confidence: rule.confidence,
      evidence: [{ file, line: spec.line, snippet: spec.snippet, matched: spec.text }],
    });
  }

  return out;
}

/** `export const runtime = 'edge'` in a route handler or page. */
function scanRuntimeExports(root: string, source: SourceFile): Finding[] {
  const file = rel(root, source.getFilePath());
  const out: Finding[] = [];
  const rule = CONFIG_RULES['route:edge-runtime'];
  if (!rule) return out;

  for (const decl of source.getVariableDeclarations()) {
    if (decl.getName() !== 'runtime') continue;
    const init = decl.getInitializer();
    if (!init || !init.isKind(SyntaxKind.StringLiteral)) continue;
    if (init.getLiteralValue() !== 'edge') continue;

    out.push({
      id: findingId(rule.kind, file, 'runtime=edge'),
      kind: rule.kind,
      blast: rule.blast,
      title: rule.title,
      why: rule.why,
      confidence: rule.confidence,
      evidence: [
        {
          file,
          line: decl.getStartLineNumber(),
          snippet: decl.getText(),
          matched: 'runtime edge',
        },
      ],
    });
  }

  return out;
}

/**
 * ISR signals: `export const revalidate = N` (time-based) and any use of
 * `revalidatePath` / `revalidateTag` / `unstable_cache` (on-demand). Both write
 * to the per-process filesystem cache, so both split-brain across replicas.
 */
function scanIsr(root: string, source: SourceFile): Finding[] {
  const file = rel(root, source.getFilePath());
  const out: Finding[] = [];
  const rule = CONFIG_RULES['isr:revalidate'];
  if (!rule) return out;

  for (const decl of source.getVariableDeclarations()) {
    if (decl.getName() !== 'revalidate') continue;
    if (!decl.isExported()) continue;
    if (!decl.getInitializer()) continue;

    out.push({
      id: findingId(rule.kind, file, 'export revalidate'),
      kind: rule.kind,
      blast: rule.blast,
      title: rule.title,
      why: rule.why,
      confidence: rule.confidence,
      evidence: [
        {
          file,
          line: decl.getStartLineNumber(),
          snippet: 'export const ' + decl.getText(),
          matched: 'export const revalidate',
        },
      ],
    });
  }

  for (const decl of source.getImportDeclarations()) {
    if (decl.getModuleSpecifierValue() !== 'next/cache') continue;
    const names = decl.getNamedImports().map((n) => n.getName());
    const used = names.filter((n) => ['revalidatePath', 'revalidateTag', 'unstable_cache'].includes(n));
    if (used.length === 0) continue;
    out.push({
      id: findingId(rule.kind, file, 'next/cache'),
      kind: rule.kind,
      blast: rule.blast,
      title: rule.title,
      why: rule.why,
      confidence: rule.confidence,
      evidence: [
        {
          file,
          line: decl.getStartLineNumber(),
          snippet: firstLine(decl.getText()),
          matched: 'next/cache: ' + used.join(', '),
        },
      ],
    });
  }

  return out;
}

async function scanVercelJson(root: string): Promise<Finding[]> {
  const path = resolve(root, 'vercel.json');
  const json = await readJson<{ crons?: { path: string; schedule: string }[] }>(path);
  if (!json?.crons?.length) return [];

  const rule = CONFIG_RULES['vercel.json:crons'];
  if (!rule) return [];

  return [
    {
      id: findingId(rule.kind, 'vercel.json', 'crons'),
      kind: rule.kind,
      blast: rule.blast,
      title: rule.title,
      why: rule.why,
      confidence: rule.confidence,
      evidence: json.crons.map((cron) => ({
        file: 'vercel.json',
        snippet: cron.schedule + ' -> ' + cron.path,
        matched: cron.path,
      })),
    },
  ];
}

async function scanNextConfig(
  root: string,
  fw: DetectedFramework,
  deps: Record<string, string>,
): Promise<Finding[]> {
  if (!fw.configPath) return [];
  // `sharp` in package.json is what the port adds; once present the optimizer is
  // production-ready and there is nothing left for Porter to change.
  if (deps['sharp']) return [];
  const text = await readText(resolve(root, fw.configPath));
  if (text === null) return [];
  if (!/images\s*:/.test(text)) return [];

  const rule = CONFIG_RULES['next.config:images'];
  if (!rule) return [];

  const line = text.split('\n').findIndex((l) => /images\s*:/.test(l)) + 1;
  return [
    {
      id: findingId(rule.kind, fw.configPath, 'images'),
      kind: rule.kind,
      blast: rule.blast,
      title: rule.title,
      why: rule.why,
      confidence: rule.confidence,
      evidence: [
        {
          file: fw.configPath,
          line,
          snippet: 'images: { remotePatterns, formats, ... }',
          matched: 'images',
        },
      ],
    },
  ];
}

/**
 * Middleware is a finding only when it is explicitly pinned to `runtime: 'edge'`.
 * Middleware with no pin runs identically self-hosted, and the Vercel-specific
 * things it might import are reported separately as platform-sdk findings.
 */
async function scanMiddleware(root: string): Promise<Finding[]> {
  const rule = CONFIG_RULES['middleware:edge-runtime'];
  if (!rule) return [];

  const candidates = ['middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js'];
  for (const candidate of candidates) {
    const path = resolve(root, candidate);
    if (!(await exists(path))) continue;

    const text = (await readText(path)) ?? '';
    const lines = text.split(/\r?\n/);
    const index = lines.findIndex((l) => /runtime\s*:\s*["']edge["']/.test(l));
    if (index === -1) return [];

    return [
      {
        id: findingId(rule.kind, candidate, 'middleware'),
        kind: rule.kind,
        blast: rule.blast,
        title: rule.title,
        why: rule.why,
        confidence: rule.confidence,
        evidence: [{ file: candidate, line: index + 1, snippet: "runtime: 'edge'", matched: 'middleware' }],
      },
    ];
  }
  return [];
}

/**
 * The repo says nothing about how to build or run it off-platform: no
 * Dockerfile, so the only build recipe is Vercel's.
 */
async function scanBuildOutput(
  root: string,
  fw: DetectedFramework,
  pkg: PackageJson,
  deps: Record<string, string>,
): Promise<Finding[]> {
  const rule = CONFIG_RULES['build:no-container'];
  if (!rule) return [];
  if (fw.major === 0) return [];
  if (await exists(resolve(root, 'Dockerfile'))) return [];

  const usesVercel =
    (await exists(resolve(root, 'vercel.json'))) ||
    (await exists(resolve(root, '.vercel'))) ||
    Object.keys(deps).some((name) => name.startsWith('@vercel/'));
  if (!usesVercel) return [];

  return [
    {
      id: findingId(rule.kind, 'Dockerfile', 'missing'),
      kind: rule.kind,
      blast: rule.blast,
      title: rule.title,
      why: rule.why,
      confidence: rule.confidence,
      evidence: [
        {
          file: 'package.json',
          snippet: pkg.packageManager ? `packageManager: ${pkg.packageManager}` : 'no Dockerfile at repo root',
          matched: 'no-container',
        },
      ],
    },
  ];
}

/** Collapse repeated findings, merging their evidence. */
function dedupe(findings: Finding[]): Finding[] {
  const byId = new Map<string, Finding>();
  for (const finding of findings) {
    const existing = byId.get(finding.id);
    if (existing) {
      existing.evidence.push(...finding.evidence);
    } else {
      byId.set(finding.id, { ...finding, evidence: [...finding.evidence] });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
