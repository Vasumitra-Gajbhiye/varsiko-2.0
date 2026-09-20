import type { Finding } from '../inventory/schema.js';
import { rewriteImportSpecifier } from '../util/ast.js';
import { rel } from '../util/fs.js';
import { appSourceFiles, importFor, libPath, stamp, template } from './shared.js';
import type { PortStep, Transform, TransformContext } from './types.js';

/**
 * `@vercel/kv` -> Redis.
 *
 * The import rewrite is trivial. The reason this transform is worth writing
 * carefully is the serialisation mismatch documented at length in the shim:
 * Upstash auto-JSON-encodes values, plain Redis does not, and the difference
 * surfaces as corrupted reads rather than errors. The shim reproduces Upstash
 * semantics so that no call site has to change.
 */
export const kvTransform: Transform = {
  id: 'kv',
  kind: 'kv-store',
  summary: 'Point the key-value store at Redis instead of Vercel KV',

  claims(finding: Finding) {
    return finding.kind === 'kv-store';
  },

  async plan(findings: Finding[], ctx: TransformContext): Promise<PortStep | null> {
    const edited: string[] = [];

    for (const file of appSourceFiles(ctx)) {
      if (rewriteImportSpecifier(file, '@vercel/kv', importFor(ctx, file, 'kv'))) {
        edited.push(rel(ctx.repoRoot, file.getFilePath()));
      }
    }

    // Idempotency: a repo already ported has no `@vercel/kv` imports left, so
    // nothing was rewritten and there is no step to report.
    if (edited.length === 0) return null;

    const shim = await template('kv/index.ts');

    return {
      id: 'kv',
      kind: 'kv-store',
      title: 'Replace Vercel KV with Redis behind an API-compatible shim',
      rationale:
        '`@vercel/kv` reaches Upstash Redis over REST using credentials Vercel provisions, ' +
        'so every call fails off-platform. The replacement is a module exporting the same `kv` ' +
        'object backed by `ioredis`, which means **no call site changes** — only the import ' +
        'specifier does.\n\n' +
        'The shim exists rather than a direct `ioredis` swap because Upstash **auto-serialises ' +
        'values to JSON and parses them back**, and plain Redis does not. A direct swap turns ' +
        '`kv.set(k, {a:1})` into the stored string `[object Object]`, which does not throw — it ' +
        'surfaces later as `undefined` field reads. The shim reproduces the Upstash behaviour ' +
        'exactly, including returning bare strings unparsed.\n\n' +
        'One deliberate deviation: `kv.keys()` is implemented with `SCAN` rather than `KEYS`, ' +
        'because `KEYS` blocks the Redis server on a large database.',
      discharges: findings.map((f) => f.id),
      editedFiles: edited.sort(),
      newFiles: [
        {
          path: libPath(ctx.layout, 'kv/index.ts'),
          contents: stamp(shim, '@vercel/kv'),
        },
      ],
      deps: [
        { name: '@vercel/kv', range: null, reason: 'Replaced by the Redis-backed shim.' },
        {
          name: 'ioredis',
          range: '^5.4.1',
          reason: 'Redis client. Chosen over `redis` for its simpler pipeline API and reconnect defaults.',
        },
      ],
      env: [
        {
          name: 'REDIS_URL',
          example: 'redis://default:CHANGE_ME@redis:6379',
          required: true,
          description:
            'Redis connection string. Use `rediss://` for TLS. The app holds one long-lived ' +
            'connection rather than the per-request HTTP round trip Vercel KV made.',
          replaces: 'KV_REST_API_URL + KV_REST_API_TOKEN',
        },
      ],
      caveats: [
        'Existing data in Vercel KV is not migrated. If the store holds anything that must ' +
          'survive (sessions, counters, rate-limit windows), dump and reload it before cutover — ' +
          'Porter does not move data, only code.',
        'Vercel KV was durable and replicated. A single self-hosted Redis is neither. Decide ' +
          'explicitly whether this data can be lost, and enable AOF persistence if it cannot.',
        'Redis 6.2 or newer is required: `kv.zrange(..., { rev: true })` maps to `ZRANGE ... REV`.',
      ],
    };
  },
};
