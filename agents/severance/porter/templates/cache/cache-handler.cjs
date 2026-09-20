/**
 * Redis-backed incremental cache handler for self-hosted Next.js.
 *
 * Written by Porter (Severance agent 03).
 *
 * WHY THIS FILE EXISTS
 *
 * Self-hosted, Next.js writes ISR output to `.next/cache` on local disk. With
 * one container that is fine. The moment there is more than one:
 *
 *   - Each replica renders and caches independently, so two users hitting the
 *     same URL can see pages generated minutes apart.
 *   - `revalidatePath()` / `revalidateTag()` only clears the replica that
 *     happened to receive the POST. The others keep serving the stale page.
 *   - Containers are ephemeral. A redeploy throws the whole cache away, so the
 *     first request after every deploy pays full render cost.
 *
 * None of that throws. It looks like "the site is a bit stale sometimes", which
 * is why it survives code review and ships.
 *
 * HOW INVALIDATION WORKS
 *
 * `revalidateTag` records "tag T was invalidated at time X" in one Redis hash.
 * Every read compares its entry's tags against that hash and treats an entry
 * written before X as a miss. Timestamps rather than deleting every tagged
 * entry: deletion needs a reverse index and races with concurrent writes.
 *
 * Page and route entries carry their tags in the `x-next-cache-tags` response
 * header, not in `ctx.tags`; `revalidatePath('/x')` is a `revalidateTag` on an
 * implicit `_N_T_/x` tag. A handler that only reads `ctx.tags` never sees them,
 * and `revalidatePath` silently stops working.
 *
 * Wiring: `cacheHandler` in next.config, plus `cacheMaxMemorySize: 0` to stop
 * the in-process LRU shadowing Redis with per-replica state.
 *
 * Env:
 *   REDIS_URL           redis://default:password@host:6379
 *   ISR_CACHE_PREFIX    optional, defaults to "next-isr"
 *   ISR_CACHE_TTL       optional hard ceiling in seconds, defaults to 30 days
 */

const PREFIX = process.env.ISR_CACHE_PREFIX || 'next-isr';
const HARD_TTL = Number(process.env.ISR_CACHE_TTL || 60 * 60 * 24 * 30);
const TAGS_HEADER = 'x-next-cache-tags';

const entryKey = (key) => `${PREFIX}:entry:${key}`;
const REVALIDATED_TAGS = `${PREFIX}:revalidated-tags`;

/** One connection per process, created lazily. A failed connect is retried, not remembered forever. */
let client = null;
let connecting = null;
let failedAt = 0;

async function getClient() {
  if (client) return client;
  if (connecting) return connecting;

  const url = process.env.REDIS_URL;
  if (!url) {
    if (!failedAt) console.warn('[porter-cache] REDIS_URL is not set; ISR cache is disabled.');
    failedAt = Date.now();
    return null;
  }
  // Back off after a failure so a dead Redis costs one attempt per few seconds, not one per request.
  if (failedAt && Date.now() - failedAt < 5000) return null;

  const Redis = require('ioredis');
  const candidate = new Redis(url, {
    lazyConnect: true,
    // Next.js calls the handler on the request path. A cache lookup that hangs is
    // worse than a miss, so fail fast and let Next render.
    connectTimeout: 3000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 200, 3000),
  });
  candidate.on('error', (error) => console.warn('[porter-cache] redis error:', error.message));

  connecting = candidate
    .connect()
    .then(() => {
      client = candidate;
      failedAt = 0;
      return client;
    })
    .catch((error) => {
      console.warn('[porter-cache] redis connect failed:', error.message);
      candidate.disconnect();
      failedAt = Date.now();
      return null;
    })
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

/** Buffers and Maps appear in page entries (`rscData`, `segmentData`); plain JSON destroys them. */
function replacer(key, value) {
  const raw = this[key];
  if (Buffer.isBuffer(raw)) return { __porter: 'buffer', base64: raw.toString('base64') };
  if (raw instanceof Map) return { __porter: 'map', entries: [...raw.entries()] };
  return value;
}

function reviver(_key, value) {
  if (value && typeof value === 'object') {
    if (value.__porter === 'buffer') return Buffer.from(value.base64, 'base64');
    if (value.__porter === 'map') return new Map(value.entries);
  }
  return value;
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

/** Every tag an entry should be invalidated by. */
function tagsOf(data, ctx) {
  const fromHeader =
    data && data.headers && typeof data.headers[TAGS_HEADER] === 'string'
      ? data.headers[TAGS_HEADER].split(',')
      : [];
  return unique([...((ctx && ctx.tags) || []), ...((data && data.tags) || []), ...fromHeader]);
}

module.exports = class PorterCacheHandler {
  constructor(options) {
    this.options = options || {};
  }

  async get(key, ctx) {
    const redis = await getClient();
    if (!redis) return null;

    try {
      const raw = await redis.get(entryKey(key));
      if (!raw) return null;
      const entry = JSON.parse(raw, reviver);

      // Soft tags are the implicit `_N_T_/path` tags Next.js passes on read.
      const tags = unique([...(entry.tags || []), ...((ctx && ctx.softTags) || [])]);
      if (tags.length > 0) {
        const stamps = await redis.hmget(REVALIDATED_TAGS, ...tags);
        for (const stamp of stamps) {
          if (stamp && Number(stamp) > (entry.lastModified || 0)) return null;
        }
      }
      return { value: entry.value, lastModified: entry.lastModified };
    } catch (error) {
      console.warn('[porter-cache] get failed:', error.message);
      return null;
    }
  }

  async set(key, data, ctx) {
    const redis = await getClient();
    if (!redis) return;

    try {
      // Next.js passes null to delete an entry.
      if (data === null || data === undefined) {
        await redis.del(entryKey(key));
        return;
      }
      const entry = { value: data, lastModified: Date.now(), tags: tagsOf(data, ctx) };

      // `revalidate` is the soft TTL Next.js enforces itself by comparing
      // lastModified. The Redis TTL is only a hard ceiling so abandoned keys
      // do not accumulate forever.
      const soft = ctx && typeof ctx.revalidate === 'number' ? Math.max(ctx.revalidate * 2, 60) : HARD_TTL;
      await redis.set(entryKey(key), JSON.stringify(entry, replacer), 'EX', Math.min(soft, HARD_TTL));
    } catch (error) {
      console.warn('[porter-cache] set failed:', error.message);
    }
  }

  async revalidateTag(tagOrTags) {
    const tags = unique(Array.isArray(tagOrTags) ? tagOrTags : [tagOrTags]);
    if (tags.length === 0) return;

    const redis = await getClient();
    if (!redis) return;

    try {
      const now = String(Date.now());
      const fields = [];
      for (const tag of tags) fields.push(tag, now);
      // Every replica reads the same hash, so one call invalidates everywhere.
      await redis.hset(REVALIDATED_TAGS, ...fields);
    } catch (error) {
      console.warn('[porter-cache] revalidateTag failed:', error.message);
    }
  }

  resetRequestCache() {}
};

/** Close the shared connection. Call from a shutdown hook; Vercel never needed this. */
module.exports.disconnect = async () => {
  const current = client;
  client = null;
  failedAt = 0;
  if (current) await current.quit().catch(() => current.disconnect());
};
