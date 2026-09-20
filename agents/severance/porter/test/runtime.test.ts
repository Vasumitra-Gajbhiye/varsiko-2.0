import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeRedis } from './helpers/fake-redis.js';

const here = dirname(fileURLToPath(import.meta.url));
const templates = resolve(here, '../templates');
const require = createRequire(import.meta.url);

const scheduler = await import(pathToFileURL(resolve(templates, 'cron/scheduler.mjs')).href);

// ---------------------------------------------------------------------------
// Cron expressions
// ---------------------------------------------------------------------------

const at = (iso: string) => new Date(iso);

test('cron: fires on the minute the expression names', () => {
  const daily = scheduler.parseCron('0 9 * * *');
  assert.equal(scheduler.matches(daily, at('2026-03-04T09:00:00Z')), true);
  assert.equal(scheduler.matches(daily, at('2026-03-04T09:01:00Z')), false);
  assert.equal(scheduler.matches(daily, at('2026-03-04T08:00:00Z')), false);

  const quarter = scheduler.parseCron('*/15 * * * *');
  for (const minute of [0, 15, 30, 45]) {
    assert.equal(scheduler.matches(quarter, at(`2026-03-04T10:${String(minute).padStart(2, '0')}:00Z`)), true);
  }
  assert.equal(scheduler.matches(quarter, at('2026-03-04T10:07:00Z')), false);
});

test('cron: schedules are evaluated in UTC, like Vercel', () => {
  const daily = scheduler.parseCron('30 2 * * *');
  // 02:30 UTC is the same instant regardless of the host timezone.
  assert.equal(scheduler.matches(daily, new Date(Date.UTC(2026, 2, 4, 2, 30))), true);
  assert.equal(scheduler.matches(daily, new Date(Date.UTC(2026, 2, 4, 3, 30))), false);
});

test('cron: named months and weekdays, ranges and lists', () => {
  const weekdays = scheduler.parseCron('0 9 * * mon-fri');
  assert.equal(scheduler.matches(weekdays, at('2026-03-04T09:00:00Z')), true); // Wednesday
  assert.equal(scheduler.matches(weekdays, at('2026-03-07T09:00:00Z')), false); // Saturday

  const list = scheduler.parseCron('0 0 1,15 jan,jul *');
  assert.equal(scheduler.matches(list, at('2026-01-15T00:00:00Z')), true);
  assert.equal(scheduler.matches(list, at('2026-07-01T00:00:00Z')), true);
  assert.equal(scheduler.matches(list, at('2026-02-01T00:00:00Z')), false);

  // Sunday is both 0 and 7.
  assert.equal(scheduler.matches(scheduler.parseCron('0 0 * * 7'), at('2026-03-08T00:00:00Z')), true);
});

test('cron: when both day fields are restricted, either may match (POSIX)', () => {
  const s = scheduler.parseCron('0 0 13 * fri');
  assert.equal(scheduler.matches(s, at('2026-03-13T00:00:00Z')), true); // 13th and a Friday
  assert.equal(scheduler.matches(s, at('2026-05-13T00:00:00Z')), true); // 13th, not a Friday
  assert.equal(scheduler.matches(s, at('2026-03-06T00:00:00Z')), true); // a Friday, not the 13th
  assert.equal(scheduler.matches(s, at('2026-03-05T00:00:00Z')), false);
});

test('cron: malformed expressions are rejected, not silently ignored', () => {
  for (const bad of ['0 9 * *', '60 * * * *', '* 25 * * *', 'every minute', '0 9 * * xyz']) {
    assert.throws(() => scheduler.parseCron(bad), `"${bad}" should throw`);
  }
});

test('cron: nextRun finds the following occurrence', () => {
  const next = scheduler.nextRun(scheduler.parseCron('0 9 * * *'), at('2026-03-04T09:00:30Z'));
  assert.equal(next?.toISOString(), '2026-03-05T09:00:00.000Z');
});

test('cron: unset variables fail loudly rather than building a broken URL', () => {
  assert.equal(
    scheduler.expand('${PUBLIC_BASE_URL}/api/cron', { PUBLIC_BASE_URL: 'https://x.example' }),
    'https://x.example/api/cron',
  );
  assert.throws(() => scheduler.expand('${PUBLIC_BASE_URL}/api/cron', {}), /PUBLIC_BASE_URL is not set/);
});

// ---------------------------------------------------------------------------
// KV shim
// ---------------------------------------------------------------------------

test('kv shim: reproduces Upstash auto-serialisation', async (t) => {
  const fake = await startFakeRedis();
  process.env.REDIS_URL = fake.url;
  const { kv, disconnect } = await import(pathToFileURL(resolve(templates, 'kv/index.ts')).href);
  t.after(async () => {
    await disconnect();
    await fake.close();
    delete process.env.REDIS_URL;
  });

  // The whole reason the shim exists: objects round-trip as objects.
  await kv.set('session:1', { user: 7, roles: ['admin'] });
  assert.deepEqual(await kv.get('session:1'), { user: 7, roles: ['admin'] });
  assert.ok(!(fake.raw('session:1') ?? '').includes('[object Object]'));

  // Bare strings come back bare, not JSON-quoted.
  await kv.set('greeting', 'hello');
  assert.equal(await kv.get('greeting'), 'hello');
  assert.equal(fake.raw('greeting'), 'hello');

  assert.equal(await kv.get('missing'), null);
});

test('kv shim: counters, expiry and sorted sets behave like Vercel KV', async (t) => {
  const fake = await startFakeRedis();
  process.env.REDIS_URL = fake.url;
  const { kv, disconnect } = await import(
    pathToFileURL(resolve(templates, 'kv/index.ts')).href + '?counters'
  );
  t.after(async () => {
    await disconnect();
    await fake.close();
    delete process.env.REDIS_URL;
  });

  // The fixture's rate limiter: incr, then expire on first hit.
  assert.equal(await kv.incr('ratelimit:a'), 1);
  assert.equal(await kv.expire('ratelimit:a', 60), 1);
  assert.equal(await kv.incr('ratelimit:a'), 2);
  assert.ok((await kv.ttl('ratelimit:a')) > 0);

  // trackView / topProducts.
  await kv.zincrby('product:views', 1, 'kettle');
  await kv.zincrby('product:views', 5, 'lamp');
  await kv.zincrby('product:views', 3, 'tray');
  assert.deepEqual(await kv.zrange('product:views', 0, 1, { rev: true }), ['lamp', 'tray']);

  await kv.set('ttl:short', 'x', { ex: 60 });
  assert.ok((await kv.ttl('ttl:short')) > 0);

  // `keys` is SCAN-backed but must still answer the same question.
  await kv.set('scan:1', 'a');
  await kv.set('scan:2', 'b');
  assert.deepEqual((await kv.keys('scan:*')).sort(), ['scan:1', 'scan:2']);
});

test('kv shim: a missing REDIS_URL fails with an actionable message', async () => {
  delete process.env.REDIS_URL;
  const { redis } = await import(pathToFileURL(resolve(templates, 'kv/index.ts')).href + '?noenv');
  assert.throws(() => redis(), /Missing REDIS_URL.*\.env\.porter\.example/s);
});
