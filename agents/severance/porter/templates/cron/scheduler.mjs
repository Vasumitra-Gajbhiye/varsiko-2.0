/**
 * Cron runner for self-hosted Next.js. Zero dependencies.
 *
 * Written by Porter (Severance agent 03).
 *
 * WHY THIS FILE EXISTS
 *
 * `vercel.json` `crons` are read by Vercel's scheduler and by nothing else.
 * Off-platform the routes still exist and still answer; nothing calls them.
 * Nothing errors — the daily digest simply stops arriving. This runner reads
 * the schedule Porter extracted (`infra/porter-schedules.json`) and calls the
 * same routes on the same UTC schedule, with the same bearer token.
 *
 * Usage:
 *   node infra/scheduler.mjs                run forever
 *   node infra/scheduler.mjs --once <id>    fire one job now and exit (smoke test)
 *   node infra/scheduler.mjs --list         print jobs and their next run
 *
 * Env:
 *   PUBLIC_BASE_URL   origin the jobs call, e.g. https://app.example.com
 *   CRON_SECRET       sent as `Authorization: Bearer <secret>`
 *   REDIS_URL         optional; when set, a per-minute lock ensures only one
 *                     replica fires each job (needed when this runs in-process)
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const NAMES = {
  month: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
  dow: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
};

/** Parse one cron field into the set of values it matches. */
function parseField(field, min, max, names) {
  const out = new Set();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${field}"`);

    const value = (token) => {
      const named = names ? names.indexOf(token.toLowerCase()) : -1;
      if (named !== -1) return named + (min === 1 ? 1 : 0);
      const n = Number(token);
      if (!Number.isInteger(n)) throw new Error(`bad value "${token}" in "${field}"`);
      return n;
    };

    let lo;
    let hi;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = value(a);
      hi = value(b);
    } else {
      lo = value(rangePart);
      hi = stepPart === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`"${field}" is outside ${min}-${max}`);
    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  return out;
}

/** Parse a 5-field cron expression. Throws on anything malformed. */
export function parseCron(expression) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`expected 5 fields, got ${fields.length}: "${expression}"`);
  const [minute, hour, dom, month, dow] = fields;
  const dowSet = parseField(dow, 0, 7, NAMES.dow);
  if (dowSet.has(7)) dowSet.add(0);
  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(month, 1, 12, NAMES.month),
    dow: dowSet,
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  };
}

/** Does this parsed schedule fire at the given instant, evaluated in UTC? */
export function matches(schedule, date) {
  if (!schedule.minute.has(date.getUTCMinutes())) return false;
  if (!schedule.hour.has(date.getUTCHours())) return false;
  if (!schedule.month.has(date.getUTCMonth() + 1)) return false;
  const domOk = schedule.dom.has(date.getUTCDate());
  const dowOk = schedule.dow.has(date.getUTCDay());
  // POSIX: when both day fields are restricted, either one may match.
  if (schedule.domRestricted && schedule.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/** The next instant, after `from`, at which the schedule fires. */
export function nextRun(schedule, from = new Date()) {
  const t = new Date(from.getTime());
  t.setUTCSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    t.setUTCMinutes(t.getUTCMinutes() + 1);
    if (matches(schedule, t)) return new Date(t.getTime());
  }
  return null;
}

/** Replace `${VAR}` with the environment value. Unset variables are an error, not an empty string. */
export function expand(text, env) {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const value = env[name];
    if (value === undefined || value === '') throw new Error(`${name} is not set`);
    return value;
  });
}

async function fire(job, env, log) {
  const started = Date.now();
  try {
    const headers = {};
    for (const [key, value] of Object.entries(job.headers || {})) headers[key] = expand(value, env);
    const response = await fetch(expand(job.url, env), {
      method: job.method || 'GET',
      headers,
      signal: AbortSignal.timeout(job.timeoutMs || 60_000),
    });
    log(`${job.id} -> ${response.status} in ${Date.now() - started}ms`);
    return response.ok;
  } catch (error) {
    log(`${job.id} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function loadManifest(path) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  return manifest.jobs.map((job) => ({ ...job, schedule: parseCron(job.schedule), expression: job.schedule }));
}

/** Try to take the per-job, per-minute lock. Without Redis every caller wins. */
async function makeLock(redisUrl, log) {
  if (!redisUrl) return async () => true;
  try {
    const { default: Redis } = await import('ioredis');
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
    redis.on('error', (error) => log(`lock redis error: ${error.message}`));
    return async (jobId, minute) => {
      try {
        return (await redis.set(`porter:cron:${jobId}:${minute}`, '1', 'EX', 120, 'NX')) === 'OK';
      } catch {
        // If the lock is unavailable, run rather than skip: a duplicate run of an
        // idempotent job is better than a schedule that silently stops.
        return true;
      }
    };
  } catch {
    log('REDIS_URL is set but ioredis is not installed; running without a lock');
    return async () => true;
  }
}

export async function startScheduler({
  manifestPath = resolve(here, 'porter-schedules.json'),
  env = process.env,
  log = (message) => console.log(`[porter-cron] ${new Date().toISOString()} ${message}`),
  redisUrl = env.REDIS_URL,
} = {}) {
  const jobs = await loadManifest(manifestPath);
  const lock = await makeLock(redisUrl, log);
  log(`loaded ${jobs.length} job(s) from ${manifestPath}`);

  let lastMinute = -1;
  const tick = async () => {
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute === lastMinute) return;
    lastMinute = minute;
    for (const job of jobs) {
      if (!matches(job.schedule, now)) continue;
      if (!(await lock(job.id, minute))) continue;
      void fire(job, env, log);
    }
  };

  // Poll every second and act once per minute: robust to timer drift and to a
  // process that was suspended across a minute boundary.
  const timer = setInterval(() => void tick(), 1000);
  return () => clearInterval(timer);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const manifestPath = resolve(here, 'porter-schedules.json');

  if (args[0] === '--list') {
    for (const job of await loadManifest(manifestPath)) {
      console.log(`${job.id}\t${job.expression}\tnext ${nextRun(job.schedule)?.toISOString()}`);
    }
  } else if (args[0] === '--once') {
    const job = (await loadManifest(manifestPath)).find((j) => j.id === args[1]);
    if (!job) {
      console.error(`no job with id "${args[1]}"`);
      process.exit(2);
    }
    const ok = await fire(job, process.env, console.log);
    process.exit(ok ? 0 : 1);
  } else {
    const stop = await startScheduler({ manifestPath });
    const shutdown = () => {
      stop();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }
}
