import type { Finding } from '../inventory/schema.js';
import { removeEdgeRuntimeExport, removeEdgeRuntimeFromConfig } from '../util/ast.js';
import { rel } from '../util/fs.js';
import { appSourceFiles } from './shared.js';
import type { PortStep, Transform, TransformContext } from './types.js';

function isMiddlewareFile(path: string): boolean {
  return /(^|[\\/])middleware\.[cm]?[jt]sx?$/.test(path);
}

/**
 * Drops `runtime: 'edge'` pins from middleware and route handlers.
 *
 * This transform owns the pins and nothing else. The Vercel-only helpers a
 * middleware usually imports (`@vercel/functions`, `@vercel/edge-config`) are
 * rewritten by the platform transform, which is the single owner of those shims.
 * Two transforms rewriting the same import is how a shim gets referenced and
 * never written.
 */
export const middlewareTransform: Transform = {
  id: 'middleware',
  kind: 'edge-middleware',
  summary: 'Remove Edge runtime pins from middleware and route handlers',

  claims(finding: Finding) {
    return finding.kind === 'edge-middleware' || finding.kind === 'edge-runtime';
  },

  async plan(findings: Finding[], ctx: TransformContext): Promise<PortStep | null> {
    const edited = new Set<string>();

    for (const file of appSourceFiles(ctx)) {
      let changed = removeEdgeRuntimeExport(file);
      if (isMiddlewareFile(file.getFilePath()) && removeEdgeRuntimeFromConfig(file)) changed = true;
      if (changed) edited.add(rel(ctx.repoRoot, file.getFilePath()));
    }

    if (edited.size === 0) return null;

    return {
      id: 'middleware',
      kind: 'edge-middleware',
      title: 'Drop Edge runtime pins',
      rationale:
        "`runtime: 'edge'` selects the Edge runtime. Off Vercel there is no edge network behind it: " +
        'route handlers pinned to it run in a restricted sandbox inside your Node server for no benefit, ' +
        'so Porter removes the pin and they run on the regular Node runtime. Middleware keeps running in ' +
        "Next.js's own edge sandbox self-hosted (a Node runtime for middleware needs Next.js 15.5+), so " +
        'for middleware the pin was redundant rather than harmful. The Vercel-only helpers such code ' +
        'imports are handled in the platform step.',
      // A finding is discharged only when the file it points at was actually edited.
      discharges: findings.filter((f) => f.evidence.some((e) => edited.has(e.file))).map((f) => f.id),
      editedFiles: [...edited].sort(),
      newFiles: [],
      deps: [],
      env: [],
      caveats: [
        'Code that relied on the Edge runtime being restricted (for example, code that assumed no Node APIs) ' +
          'now has access to them. That is only a problem if something depended on the restriction.',
      ],
    };
  },
};
