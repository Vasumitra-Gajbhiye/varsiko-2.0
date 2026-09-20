import type { SourceFile } from 'ts-morph';
import type { Finding } from '../inventory/schema.js';
import { importsFrom, removeImport, removeJsxElements, rewriteImportSpecifier } from '../util/ast.js';
import { rel } from '../util/fs.js';
import { appSourceFiles, findingsMatching, importFor, libPath, stamp, template } from './shared.js';
import type { NewFile, PortStep, Transform, TransformContext } from './types.js';

/** Components that only exist to beacon to Vercel; safe to delete with their import. */
const BEACON_COMPONENTS = new Set(['Analytics', 'SpeedInsights']);
const BEACON_PACKAGES = ['@vercel/analytics', '@vercel/speed-insights'];

/**
 * True when every binding imported from `specifier` is a beacon component.
 * `import { track } from '@vercel/analytics'` is a call site, and deleting its
 * import would break the build, so those files are left for a human.
 */
function onlyBeaconImports(file: SourceFile, specifier: string): boolean {
  return file
    .getImportDeclarations()
    .filter((d) => {
      const value = d.getModuleSpecifierValue();
      return value === specifier || value.startsWith(specifier + '/');
    })
    .every(
      (d) =>
        !d.getDefaultImport() &&
        !d.getNamespaceImport() &&
        d.getNamedImports().every((n) => BEACON_COMPONENTS.has(n.getName())),
    );
}

/**
 * Vercel platform SDKs. The single owner of these rewrites, and of the shim
 * files they point at.
 *
 *   @vercel/functions      -> request-context shim  (geolocation, ipAddress)
 *   @vercel/edge-config    -> env-backed shim
 *   @vercel/analytics      -> removed
 *   @vercel/speed-insights -> removed
 *
 * `@vercel/postgres` and `@vercel/otel` are detected but not rewritten: neither
 * has a drop-in replacement, so they stay in the unhandled list.
 */
export const platformTransform: Transform = {
  id: 'platform-sdk',
  kind: 'platform-sdk',
  summary: 'Replace or remove Vercel-only platform SDK imports',

  claims(finding: Finding) {
    return finding.kind === 'platform-sdk';
  },

  async plan(findings: Finding[], ctx: TransformContext): Promise<PortStep | null> {
    const edited = new Set<string>();
    const handled = new Set<string>();
    const skippedBeacons: string[] = [];

    for (const file of appSourceFiles(ctx)) {
      let changed = false;

      if (rewriteImportSpecifier(file, '@vercel/functions', importFor(ctx, file, 'request-context'))) {
        changed = true;
        handled.add('@vercel/functions');
      }
      if (rewriteImportSpecifier(file, '@vercel/edge-config', importFor(ctx, file, 'edge-config'))) {
        changed = true;
        handled.add('@vercel/edge-config');
      }

      for (const pkg of BEACON_PACKAGES) {
        if (!importsFrom(file, pkg)) continue;
        if (!onlyBeaconImports(file, pkg)) {
          skippedBeacons.push(`${rel(ctx.repoRoot, file.getFilePath())} (${pkg})`);
          continue;
        }
        const names = removeImport(file, pkg);
        removeJsxElements(file, names);
        changed = true;
        handled.add(pkg);
      }

      if (changed) edited.add(rel(ctx.repoRoot, file.getFilePath()));
    }

    if (edited.size === 0) return null;

    // A package is only "handled" once no file imports it any more.
    const remaining = appSourceFiles(ctx);
    const resolved = [...handled].filter((pkg) => !remaining.some((f) => importsFrom(f, pkg)));

    const newFiles: NewFile[] = [];
    if (handled.has('@vercel/functions')) {
      newFiles.push({
        path: libPath(ctx.layout, 'request-context.ts'),
        contents: stamp(await template('platform/request-context.ts'), '@vercel/functions'),
      });
    }
    if (handled.has('@vercel/edge-config')) {
      newFiles.push({
        path: libPath(ctx.layout, 'edge-config.ts'),
        contents: stamp(await template('platform/edge-config.ts'), '@vercel/edge-config'),
      });
    }

    const caveats: string[] = [
      'Porter removes Vercel Analytics and Speed Insights rather than choosing a replacement RUM provider. ' +
        'Wire your preferred analytics stack separately.',
    ];
    if (handled.has('@vercel/functions')) {
      caveats.push(
        'Geo and IP data now depend on your reverse proxy or CDN forwarding `x-geo-*`, `cf-*` or ' +
          '`x-forwarded-for` headers. Without them `geolocation()` returns empty fields and geo rules ' +
          'quietly stop applying.',
      );
    }
    if (handled.has('@vercel/edge-config')) {
      caveats.push(
        'Edge Config values now come from the `PORTER_EDGE_CONFIG_JSON` environment variable, read on every ' +
          'call. Copy your current Edge Config items into it; changing it needs a restart, not a redeploy of code.',
      );
    }
    if (skippedBeacons.length > 0) {
      caveats.push(
        `Left in place because they use more than the <Analytics/>/<SpeedInsights/> component: ${skippedBeacons.join(', ')}.`,
      );
    }

    const discharged = findingsMatching(findings, resolved).map((f) => f.id);

    return {
      id: 'platform-sdk',
      kind: 'platform-sdk',
      title: 'Replace Vercel-only platform SDK calls',
      rationale:
        'Vercel platform SDK helpers either read headers only Vercel injects, or beacon to routes only Vercel ' +
        'serves. Porter points server-side helpers at small owned shims backed by proxy headers and environment ' +
        'variables, and removes analytics beacons that would 404 off-platform.',
      discharges: discharged,
      editedFiles: [...edited].sort(),
      newFiles,
      deps: resolved.map((name) => ({
        name,
        range: null,
        reason: 'No longer imported after the port.',
      })),
      env: handled.has('@vercel/edge-config')
        ? [
            {
              name: 'PORTER_EDGE_CONFIG_JSON',
              example: '{"maintenance_mode":false}',
              required: false,
              description: 'JSON object read by the generated Edge Config replacement.',
              replaces: 'EDGE_CONFIG',
            },
          ]
        : [],
      caveats,
    };
  },
};
