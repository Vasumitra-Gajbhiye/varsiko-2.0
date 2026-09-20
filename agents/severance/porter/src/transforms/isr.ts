import { resolve } from 'node:path';
import type { Finding } from '../inventory/schema.js';
import { findNextConfigObject, isEsmConfig, upsertProperty } from '../util/ast.js';
import { exists } from '../util/fs.js';
import { appSourceFiles, stamp, template } from './shared.js';
import type { NewFile, PortStep, Transform, TransformContext } from './types.js';

/**
 * ISR and on-demand revalidation -> a Redis-backed Next.js cache handler.
 *
 * The app's own freshness contract is left alone: `export const revalidate = N`
 * keeps meaning "refresh at most every N seconds". The cache handler only moves
 * where the rendered output is stored, from one replica's disk to Redis, so the
 * same setting now holds across replicas. Removing `revalidate` would have
 * turned "refresh hourly" into "never refresh until somebody calls a webhook",
 * which is exactly the silent drift this agent exists to prevent.
 */
export const isrTransform: Transform = {
  id: 'isr',
  kind: 'isr',
  summary: 'Store ISR and revalidation state in Redis so every replica shares it',

  claims(finding: Finding) {
    return finding.kind === 'isr';
  },

  async plan(findings: Finding[], ctx: TransformContext): Promise<PortStep | null> {
    const configPath = ctx.inventory.framework.configPath;
    const source = configPath ? ctx.project.getSourceFile(resolve(ctx.repoRoot, configPath)) : undefined;
    const config = source ? findNextConfigObject(source) : null;

    const edited = new Set<string>();
    const caveats: string[] = [];
    let wired = false;

    if (source && config && configPath) {
      // `require` does not exist in an ES module, and `next.config.mjs` is the
      // default for new Next.js apps. An absolute path is needed either way,
      // because Next resolves the handler relative to its own install.
      const handlerPath = isEsmConfig(source)
        ? '`${process.cwd()}/cache-handler.cjs`'
        : "require.resolve('./cache-handler.cjs')";
      const a = upsertProperty(config, 'cacheHandler', handlerPath);
      const b = upsertProperty(config, 'cacheMaxMemorySize', '0');
      if (a || b) edited.add(configPath);
      wired = true;
    } else {
      caveats.push(
        `Could not wire the cache handler: ${configPath ?? 'no next.config file was found'} exports a ` +
          'computed config. Add `cacheHandler` (an absolute path to `cache-handler.cjs`) and ' +
          '`cacheMaxMemorySize: 0` by hand, or ISR stays on the per-replica filesystem cache.',
      );
    }

    // If the app already has a route that calls revalidatePath/revalidateTag, a
    // second one would be noise. Only generate a route when there is none.
    let existingRoute: string | null = null;
    for (const file of appSourceFiles(ctx)) {
      if (!/[\\/]route\.[cm]?[jt]sx?$/.test(file.getFilePath())) continue;
      const uses = file
        .getImportDeclarations()
        .some(
          (d) =>
            d.getModuleSpecifierValue() === 'next/cache' &&
            d.getNamedImports().some((n) => ['revalidatePath', 'revalidateTag'].includes(n.getName())),
        );
      if (uses) {
        existingRoute = file.getFilePath().replace(/\\/g, '/').replace(ctx.repoRoot.replace(/\\/g, '/') + '/', '');
        break;
      }
    }

    const newFiles: NewFile[] = [
      {
        path: 'cache-handler.cjs',
        contents: stamp(await template('cache/cache-handler.cjs'), 'default local ISR filesystem cache'),
        skipIfExists: true,
      },
    ];

    if (!existingRoute && ctx.layout.appDir) {
      newFiles.push({
        path: `${ctx.layout.appDir}/api/porter/revalidate/route.ts`,
        contents: stamp(
          await template('revalidate/route.ts'),
          'platform-local cache invalidation (on-demand revalidation endpoint)',
        ),
        skipIfExists: true,
      });
    }

    // Idempotency: nothing to write, nothing to edit.
    const handlerExists = await exists(resolve(ctx.repoRoot, 'cache-handler.cjs'));
    if (edited.size === 0 && handlerExists && newFiles.length === 1) return null;

    if (existingRoute) {
      caveats.push(
        `\`${existingRoute}\` already revalidates paths and tags. It now clears the shared Redis cache, ` +
          'so every replica sees the invalidation — no new endpoint was added.',
      );
    } else if (ctx.layout.appDir) {
      caveats.push(
        'Your CMS or deploy pipeline must call `POST /api/porter/revalidate` (Bearer `REVALIDATE_SECRET`) when ' +
          'content changes. Porter cannot infer those upstream hooks.',
      );
    } else {
      caveats.push(
        'This is a pages-router app, so no on-demand revalidation route was generated. Use `res.revalidate()` ' +
          'from an API route; it will go through the shared cache handler.',
      );
    }

    return {
      id: 'isr',
      kind: 'isr',
      title: 'Share the ISR cache across replicas through Redis',
      rationale:
        'Self-hosted, Next.js caches rendered pages in `.next/cache` on one replica\'s disk. With more than one ' +
        'container each replica renders and revalidates on its own, so users see different versions of a page ' +
        'and `revalidatePath` only clears the replica that received the call. Porter wires a Redis cache ' +
        'handler so all replicas read and write one cache and one invalidation reaches every replica. ' +
        'Your `revalidate` settings are unchanged: they keep their meaning, now enforced across replicas.',
      // Only claim the findings when the handler is actually wired into next.config.
      discharges: wired ? findings.map((f) => f.id) : [],
      editedFiles: [...edited].sort(),
      newFiles,
      deps: [{ name: 'ioredis', range: '^5.4.1', reason: 'Backs the shared Next.js cache handler.' }],
      env: [
        {
          name: 'REDIS_URL',
          example: 'redis://default:CHANGE_ME@redis:6379',
          required: true,
          description: 'Redis connection string used by the cache handler and the KV shim.',
        },
        {
          name: 'ISR_CACHE_PREFIX',
          example: 'next-isr',
          required: false,
          description: 'Redis key prefix for the shared Next.js cache.',
        },
        ...(!existingRoute && ctx.layout.appDir
          ? [
              {
                name: 'REVALIDATE_SECRET',
                example: 'CHANGE_ME_32_BYTES_OF_RANDOM',
                required: true,
                description: 'Secret accepted by the generated on-demand revalidation route.',
              },
            ]
          : []),
      ],
      caveats,
    };
  },
};
