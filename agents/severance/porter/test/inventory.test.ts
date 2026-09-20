import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRepo } from '../src/inventory/scan.js';

type Files = Record<string, string>;

async function repo(files: Files): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'porter-inv-'));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, contents, 'utf8');
  }
  return dir;
}

const NEXT_PKG = JSON.stringify({ name: 'app', dependencies: { next: '15.1.0' } });

test('finds lock-in across imports, config and vercel.json', async () => {
  const dir = await repo({
    'package.json': JSON.stringify({
      name: 'app',
      dependencies: { next: '15.1.0', '@vercel/kv': '^3.0.0', '@vercel/blob': '^0.27.0' },
    }),
    'next.config.mjs': 'export default { images: { remotePatterns: [] } };',
    'vercel.json': JSON.stringify({ crons: [{ path: '/api/cron', schedule: '0 9 * * *' }] }),
    'app/page.tsx': "import { kv } from '@vercel/kv';\nexport const revalidate = 60;\nexport default function P() { return null }\n",
    'lib/store.ts': "import { put } from '@vercel/blob';\nexport const up = put;\n",
  });
  try {
    const inventory = await scanRepo(dir);
    const kinds = new Set(inventory.findings.map((f) => f.kind));
    for (const kind of ['kv-store', 'blob-storage', 'cron', 'isr', 'image-optimization', 'build-output']) {
      assert.ok(kinds.has(kind as never), `expected a ${kind} finding`);
    }
    assert.equal(inventory.framework.router, 'app');
    assert.deepEqual(Object.keys(inventory.platformDependencies).sort(), ['@vercel/blob', '@vercel/kv']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finds platform SDKs imported by require and dynamic import', async () => {
  const dir = await repo({
    'package.json': NEXT_PKG,
    'lib/a.js': "const { kv } = require('@vercel/kv');\nmodule.exports = kv;\n",
    'lib/b.ts': "export const load = () => import('@vercel/edge-config');\n",
  });
  try {
    const kinds = (await scanRepo(dir)).findings.map((f) => f.kind);
    assert.ok(kinds.includes('kv-store'));
    assert.ok(kinds.includes('platform-sdk'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('on-demand revalidation counts as ISR even without an export', async () => {
  const dir = await repo({
    'package.json': NEXT_PKG,
    'app/api/r/route.ts': "import { revalidateTag } from 'next/cache';\nexport async function POST() { revalidateTag('x'); }\n",
  });
  try {
    assert.ok((await scanRepo(dir)).findings.some((f) => f.kind === 'isr'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an already-ported repo reports nothing left to do', async () => {
  const dir = await repo({
    'package.json': JSON.stringify({ name: 'app', dependencies: { next: '15.1.0', sharp: '^0.33.5' } }),
    'next.config.mjs': 'export default { images: {}, cacheHandler: `${process.cwd()}/cache-handler.cjs` };',
    'Dockerfile': 'FROM node:20\n',
    'app/page.tsx': 'export const revalidate = 60;\nexport default function P() { return null }\n',
  });
  try {
    assert.deepEqual((await scanRepo(dir)).findings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('middleware without an edge pin is not a finding', async () => {
  const dir = await repo({
    'package.json': NEXT_PKG,
    'vercel.json': '{}',
    'middleware.ts': "export function middleware() {}\nexport const config = { matcher: ['/x'] };\n",
  });
  try {
    assert.ok(!(await scanRepo(dir)).findings.some((f) => f.kind === 'edge-middleware'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a repo with a Dockerfile has no build-output finding', async () => {
  const dir = await repo({ 'package.json': NEXT_PKG, 'vercel.json': '{}', 'Dockerfile': 'FROM node:20\n' });
  try {
    assert.ok(!(await scanRepo(dir)).findings.some((f) => f.kind === 'build-output'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finding ids are stable across runs', async () => {
  const dir = await repo({ 'package.json': NEXT_PKG, 'lib/a.ts': "import { kv } from '@vercel/kv';\nexport default kv;\n" });
  try {
    const a = (await scanRepo(dir)).findings.map((f) => f.id);
    const b = (await scanRepo(dir)).findings.map((f) => f.id);
    assert.deepEqual(a, b);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
