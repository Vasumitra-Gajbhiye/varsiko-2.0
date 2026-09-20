/**
 * Drop-in replacement for `@vercel/kv`, backed by a plain Redis.
 *
 * Written by Porter (Severance agent 03).
 *
 * The subtle part — and the reason this file exists rather than a one-line
 * `import { createClient } from 'redis'` in every call site:
 *
 *   `@vercel/kv` is a client for Upstash Redis over REST, and Upstash
 *   **automatically JSON-serialises values on the way in and parses them on
 *   the way out**. So `await kv.set('k', { a: 1 })` followed by
 *   `await kv.get('k')` returns an object. Plain Redis stores bytes: the same
 *   two calls through ioredis return the string "[object Object]" unless you
 *   serialise yourself.
 *
 *   That difference does not throw. It produces `undefined` field accesses
 *   somewhere downstream, hours later. It is the single most likely way a
 *   Vercel KV migration corrupts data quietly, so this shim reproduces the
 *   auto-serialisation exactly, including the edge case where a value that was
 *   written as a bare string must come back as a bare string.
 *
 * Env:
 *   REDIS_URL   redis://default:password@host:6379  (rediss:// for TLS)
 */

import Redis, { type RedisOptions } from 'ioredis';

let client: Redis | undefined;

export function redis(): Redis {
  if (client) return client;

  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      'Missing REDIS_URL. Porter replaced @vercel/kv with Redis; see .env.porter.example.',
    );
  }

  const options: RedisOptions = {
    // A long-running Node server holds one connection for its lifetime. This
    // is the opposite of the serverless assumption @vercel/kv was built on,
    // and it is strictly better here: no per-request HTTP round trip.
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    // Managed Redis behind a load balancer will drop idle connections.
    // Reconnect rather than surfacing the error to a request.
    retryStrategy: (times) => Math.min(times * 200, 5000),
  };

  if (url.startsWith('rediss://')) {
    options.tls = { rejectUnauthorized: process.env.REDIS_TLS_INSECURE !== 'true' };
  }

  client = new Redis(url, options);
  return client;
}

/**
 * Upstash's serialisation, reproduced.
 *
 * Strings pass through untouched so that keys written by other systems (or by
 * `redis-cli`) stay readable. Everything else is JSON.
 */
function encode(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function decode<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Not JSON: it was written as a bare string. Return it as one, which is
    // what @vercel/kv does for the same input.
    return raw as unknown as T;
  }
}

export type SetCommandOptions = {
  /** Seconds. */
  ex?: number;
  /** Milliseconds. */
  px?: number;
  /** Unix seconds. */
  exat?: number;
  /** Unix milliseconds. */
  pxat?: number;
  /** Only set if the key does not exist. */
  nx?: boolean;
  /** Only set if the key exists. */
  xx?: boolean;
  /** Keep the existing TTL. */
  keepTtl?: boolean;
};

export type ZRangeOptions = {
  withScores?: boolean;
  rev?: boolean;
  byScore?: boolean;
  byLex?: boolean;
};

/**
 * The `kv` export. Method names and signatures mirror `@vercel/kv` so that
 * call sites do not change — only the import specifier does.
 */
export const kv = {
  // ---- strings ----

  async get<T = unknown>(key: string): Promise<T | null> {
    return decode<T>(await redis().get(key));
  },

  async mget<T = unknown>(...keys: string[]): Promise<(T | null)[]> {
    const flat = keys.flat() as string[];
    if (flat.length === 0) return [];
    const values = await redis().mget(...flat);
    return values.map((v) => decode<T>(v));
  },

  async set<T = unknown>(
    key: string,
    value: T,
    options: SetCommandOptions = {},
  ): Promise<'OK' | null> {
    const payload = encode(value);
    const args: (string | number)[] = [];

    if (options.ex !== undefined) args.push('EX', options.ex);
    else if (options.px !== undefined) args.push('PX', options.px);
    else if (options.exat !== undefined) args.push('EXAT', options.exat);
    else if (options.pxat !== undefined) args.push('PXAT', options.pxat);

    if (options.keepTtl) args.push('KEEPTTL');
    if (options.nx) args.push('NX');
    else if (options.xx) args.push('XX');

    // `call` rather than `set`: ioredis types every option combination as its own
    // overload, and this method forwards an arbitrary subset of them.
    const result = await redis().call('SET', key, payload, ...args);
    return result as 'OK' | null;
  },

  async setex<T = unknown>(key: string, seconds: number, value: T): Promise<'OK'> {
    return (await redis().setex(key, seconds, encode(value))) as 'OK';
  },

  async del(...keys: string[]): Promise<number> {
    const flat = keys.flat() as string[];
    if (flat.length === 0) return 0;
    return redis().del(...flat);
  },

  async exists(...keys: string[]): Promise<number> {
    const flat = keys.flat() as string[];
    if (flat.length === 0) return 0;
    return redis().exists(...flat);
  },

  async incr(key: string): Promise<number> {
    return redis().incr(key);
  },

  async incrby(key: string, increment: number): Promise<number> {
    return redis().incrby(key, increment);
  },

  async decr(key: string): Promise<number> {
    return redis().decr(key);
  },

  async expire(key: string, seconds: number): Promise<number> {
    return redis().expire(key, seconds);
  },

  async ttl(key: string): Promise<number> {
    return redis().ttl(key);
  },

  async keys(pattern: string): Promise<string[]> {
    // @vercel/kv exposes `keys`, but on a large database KEYS blocks the
    // server. SCAN is the same answer without the stall, so the shim upgrades
    // it silently — this is the one place it deliberately does not match.
    const found: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis().scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      found.push(...batch);
    } while (cursor !== '0');
    return found;
  },

  // ---- hashes ----

  async hget<T = unknown>(key: string, field: string): Promise<T | null> {
    return decode<T>(await redis().hget(key, field));
  },

  async hset<T = unknown>(key: string, value: Record<string, T>): Promise<number> {
    const flat: string[] = [];
    for (const [field, item] of Object.entries(value)) {
      flat.push(field, encode(item));
    }
    if (flat.length === 0) return 0;
    return redis().hset(key, ...flat);
  },

  async hgetall<T = unknown>(key: string): Promise<Record<string, T> | null> {
    const raw = await redis().hgetall(key);
    if (!raw || Object.keys(raw).length === 0) return null;
    const out: Record<string, T> = {};
    for (const [field, value] of Object.entries(raw)) {
      out[field] = decode<T>(value) as T;
    }
    return out;
  },

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const flat = fields.flat() as string[];
    if (flat.length === 0) return 0;
    return redis().hdel(key, ...flat);
  },

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    return redis().hincrby(key, field, increment);
  },

  // ---- sorted sets ----

  async zadd(
    key: string,
    ...members: { score: number; member: string }[]
  ): Promise<number | null> {
    const flat = members.flat();
    if (flat.length === 0) return 0;
    const args: (string | number)[] = [];
    for (const entry of flat) args.push(entry.score, encode(entry.member));
    return redis().zadd(key, ...(args as [number, string]));
  },

  async zincrby(key: string, increment: number, member: string): Promise<number> {
    const result = await redis().zincrby(key, increment, encode(member));
    return Number(result);
  },

  async zrange<T = string[]>(
    key: string,
    start: number,
    stop: number,
    options: ZRangeOptions = {},
  ): Promise<T> {
    const args: string[] = [];
    if (options.byScore) args.push('BYSCORE');
    if (options.byLex) args.push('BYLEX');
    if (options.rev) args.push('REV');
    if (options.withScores) args.push('WITHSCORES');

    const result = (await redis().call('ZRANGE', key, start, stop, ...args)) as string[];
    return result.map((v) => decode(v)) as T;
  },

  async zrem(key: string, ...members: string[]): Promise<number> {
    const flat = (members.flat() as string[]).map((m) => encode(m));
    if (flat.length === 0) return 0;
    return redis().zrem(key, ...flat);
  },

  async zscore(key: string, member: string): Promise<number | null> {
    const score = await redis().zscore(key, encode(member));
    return score === null ? null : Number(score);
  },

  // ---- lists ----

  async lpush<T = unknown>(key: string, ...elements: T[]): Promise<number> {
    const flat = (elements.flat() as T[]).map((e) => encode(e));
    if (flat.length === 0) return 0;
    return redis().lpush(key, ...flat);
  },

  async rpush<T = unknown>(key: string, ...elements: T[]): Promise<number> {
    const flat = (elements.flat() as T[]).map((e) => encode(e));
    if (flat.length === 0) return 0;
    return redis().rpush(key, ...flat);
  },

  async lrange<T = unknown>(key: string, start: number, stop: number): Promise<T[]> {
    const values = await redis().lrange(key, start, stop);
    return values.map((v) => decode<T>(v) as T);
  },

  async lpop<T = unknown>(key: string): Promise<T | null> {
    return decode<T>(await redis().lpop(key));
  },

  // ---- sets ----

  async sadd<T = unknown>(key: string, ...members: T[]): Promise<number> {
    const flat = (members.flat() as T[]).map((m) => encode(m));
    if (flat.length === 0) return 0;
    return redis().sadd(key, ...flat);
  },

  async smembers<T = unknown>(key: string): Promise<T[]> {
    const values = await redis().smembers(key);
    return values.map((v) => decode<T>(v) as T);
  },

  async srem<T = unknown>(key: string, ...members: T[]): Promise<number> {
    const flat = (members.flat() as T[]).map((m) => encode(m));
    if (flat.length === 0) return 0;
    return redis().srem(key, ...flat);
  },

  // ---- scripting / batching ----

  /**
   * `kv.pipeline()` in @vercel/kv batches REST calls. ioredis pipelines batch
   * on the wire, which is the same contract from the call site's perspective:
   * queue commands, `.exec()`, get an array back.
   */
  pipeline() {
    return redis().pipeline();
  },

  multi() {
    return redis().multi();
  },

  async ping(): Promise<string> {
    return redis().ping();
  },
};

export default kv;

/** Close the connection. Call from a shutdown hook; Vercel never needed this. */
export async function disconnect(): Promise<void> {
  if (!client) return;
  await client.quit();
  client = undefined;
}
