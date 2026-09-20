import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { describe, it } from 'node:test';
import { classifyService, normalizeQuantity, readJsonl, summarizeCharges } from '../src/agents/estimator/billing.ts';
import { estimate, VercelReadOnlyClient } from '../src/agents/estimator/index.ts';
import { analyzeManifest } from '../src/agents/estimator/manifest.ts';
import { recommend } from '../src/agents/estimator/sizing.ts';
import type { FocusRow, UsageSummary } from '../src/agents/estimator/types.ts';

// Synthetic rows: ServiceName/ConsumedUnit strings are assumptions, not captured from Vercel.
function row(service: string, unit: string, qty: number, cost: number, day: string, project = 'prj_1', extra: Partial<FocusRow> = {}): FocusRow {
  return {
    ChargeCategory: 'Usage',
    ChargePeriodStart: `${day}T00:00:00Z`,
    ChargePeriodEnd: `${day}T23:59:59Z`,
    ConsumedQuantity: qty,
    ConsumedUnit: unit,
    EffectiveCost: cost,
    ServiceName: service,
    Tags: { ProjectId: project, ProjectName: project === 'prj_1' ? 'shop' : 'other' },
    ...extra,
  };
}

const jsonl = (rows: FocusRow[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('classification and units', () => {
  it('maps documented Vercel metric names', () => {
    assert.equal(classifyService('Active CPU'), 'activeCpuHours');
    assert.equal(classifyService('Provisioned Memory'), 'provisionedMemoryGbHours');
    assert.equal(classifyService('Fast Data Transfer'), 'fastDataTransferGb');
    assert.equal(classifyService('Fast Origin Transfer'), 'fastOriginTransferGb');
    assert.equal(classifyService('Image Transformations'), 'imageTransformations');
    assert.equal(classifyService('Web Analytics Events'), null);
  });

  it('normalises units and rejects unknown ones', () => {
    assert.equal(normalizeQuantity('activeCpuHours', 7200, 'Seconds'), 2);
    assert.equal(normalizeQuantity('provisionedMemoryGbHours', 2048, 'MB-Hrs'), 2);
    assert.equal(normalizeQuantity('fastDataTransferGb', 1, 'TB'), 1024);
    assert.equal(normalizeQuantity('invocations', 3, '1M'), 3_000_000);
    assert.equal(normalizeQuantity('activeCpuHours', 5, 'parsecs'), null);
  });
});

describe('readJsonl', () => {
  it('reassembles rows split across chunks', async () => {
    const text = jsonl([row('Active CPU', 'Hours', 1, 0.1, '2026-09-01'), row('Active CPU', 'Hours', 2, 0.2, '2026-09-02')]);
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    });
    const out: FocusRow[] = [];
    for await (const r of readJsonl(stream)) out.push(r);
    assert.deepEqual(out.map((r) => r.ConsumedQuantity), [1, 2]);
  });
});

describe('summarizeCharges', () => {
  const opts = { from: '2026-09-01T00:00:00Z', to: '2026-09-11T00:00:00Z', project: { id: 'prj_1', name: 'shop' } };

  it('filters by project, keeps peak day, ignores non-usage rows, surfaces unknown services', async () => {
    const s = await summarizeCharges(
      [
        row('Active CPU', 'Hours', 2, 0.5, '2026-09-01'),
        row('Active CPU', 'Hours', 6, 1.5, '2026-09-02'),
        row('Active CPU', 'Hours', 99, 9, '2026-09-02', 'prj_2'),
        row('Provisioned Memory', 'GB-Hrs', 48, 1, '2026-09-02'),
        row('Function Invocations', 'Requests', 1000, 0.1, '2026-09-02'),
        row('Mystery Product', 'widgets', 5, 2, '2026-09-02'),
        row('Active CPU', 'Hours', 0, -5, '2026-09-03', 'prj_1', { ChargeCategory: 'Credit', ConsumedQuantity: null }),
      ],
      opts,
    );
    assert.equal(s.window.days, 10);
    assert.equal(s.metrics.activeCpuHours?.quantity, 8);
    assert.equal(s.metrics.activeCpuHours?.peakDayQuantity, 6);
    assert.equal(s.metrics.activeCpuHours?.effectiveCost, 2);
    assert.equal(s.unclassified[0]?.service, 'Mystery Product');
    assert.equal(s.unclassified[0]?.effectiveCost, 2);
  });

  it('warns when rows carry no project tags', async () => {
    const s = await summarizeCharges([row('Active CPU', 'Hours', 1, 1, '2026-09-01', 'x', { Tags: {} })], opts);
    assert.match(s.warnings.join(' '), /project tag/);
  });

  it('accepts Tags encoded as a JSON string', async () => {
    const s = await summarizeCharges(
      [row('Active CPU', 'Hours', 1, 1, '2026-09-01', 'prj_1', { Tags: '{"ProjectId":"prj_1"}' })],
      opts,
    );
    assert.equal(s.metrics.activeCpuHours?.quantity, 1);
  });
});

describe('manifest analysis', () => {
  it('flags Prisma without generate and heavy deps', () => {
    const w = analyzeManifest({
      dependencies: { next: '^15.1.0', '@prisma/client': '^6.0.0', sharp: '^0.33.0' },
      scripts: { build: 'next build' },
    });
    assert.equal(w.framework, 'nextjs');
    assert.equal(w.frameworkMajor, 15);
    assert.equal(w.estimatedPeakMemoryMb, 512 + 150 + 300);
    assert.equal(w.cpuHeavy, true);
    assert.match(w.buildNotes.join(' '), /prisma generate/);
  });

  it('accepts prisma generate in postinstall', () => {
    const w = analyzeManifest({ dependencies: { prisma: '6' }, scripts: { postinstall: 'prisma generate' } });
    assert.ok(!w.buildNotes.some((n) => /no `prisma generate`/.test(n)));
  });
});

describe('recommend', () => {
  const usage = (over: Partial<UsageSummary['metrics']>): UsageSummary => ({
    window: { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z', days: 30 },
    metrics: over,
    unclassified: [],
    seenServices: [],
    warnings: [],
  });
  const t = (quantity: number, cost = 0) => ({ quantity, effectiveCost: cost, peakDayQuantity: quantity / 10, activeDays: 30 });

  it('keeps a light I/O-bound app on Standard', () => {
    const r = recommend({
      usage: usage({ invocations: t(1_000_000), activeCpuHours: t(10), provisionedMemoryGbHours: t(300, 3) }),
      workload: analyzeManifest({ dependencies: { next: '15.0.0', ai: '4' } }),
    });
    assert.equal(r.vercel.tier, 'standard');
    assert.equal(r.confidence, 'high');
    assert.equal(r.whatIf, null);
  });

  it('moves a headless-browser app to Performance and prices the change', () => {
    const r = recommend({
      usage: usage({ invocations: t(100_000), activeCpuHours: t(50), provisionedMemoryGbHours: t(600, 9) }),
      workload: analyzeManifest({ dependencies: { next: '15.0.0', puppeteer: '23' } }),
    });
    assert.equal(r.vercel.tier, 'performance');
    // 9 USD over 30 days doubles when memory goes 2 GB -> 4 GB: +9 USD/month
    assert.equal(r.whatIf?.monthlyCostDeltaUsd, 9);
  });

  it('flags runtime CPU-bound traffic even with a light manifest', () => {
    // 200h * 3.6e6 ms / 1e6 invocations = 720 ms per invocation
    const r = recommend({ usage: usage({ invocations: t(1_000_000), activeCpuHours: t(200) }), workload: null });
    assert.equal(r.vercel.tier, 'performance');
    assert.equal(r.confidence, 'medium');
  });

  it('has low confidence with no data at all', () => {
    const r = recommend({ usage: usage({}), workload: null });
    assert.equal(r.confidence, 'low');
    assert.equal(r.selfHost, null);
  });

  it('sizes a dedicated host from peak-day busy vCPUs', () => {
    // peak day = 240/10 = 24 CPU-hours -> 1 busy vCPU; x3 burst x1.3 = 3.9 -> 4 vCPU
    const r = recommend({ usage: usage({ invocations: t(1000), activeCpuHours: t(240) }), workload: null });
    assert.equal(r.selfHost?.vcpu, 4);
  });
});

describe('VercelReadOnlyClient', () => {
  it('only sends GET, with bearer auth and teamId', async () => {
    const calls: { url: string; method?: string; auth: string | null }[] = [];
    const client = new VercelReadOnlyClient({
      token: 'secret-token',
      teamId: 'team_1',
      fetch: async (url, init) => {
        calls.push({ url: String(url), method: init?.method, auth: new Headers(init?.headers).get('authorization') });
        return json({ projects: [{ id: 'prj_1', name: 'shop' }], pagination: { next: null } });
      },
    });
    await client.listProjects();
    assert.equal(calls[0]?.method, 'GET');
    assert.equal(calls[0]?.auth, 'Bearer secret-token');
    assert.match(calls[0]!.url, /teamId=team_1/);
  });

  it('follows pagination', async () => {
    let n = 0;
    const client = new VercelReadOnlyClient({
      token: 't',
      fetch: async (url) => {
        n++;
        const from = new URL(String(url)).searchParams.get('from');
        return from
          ? json({ projects: [{ id: 'b', name: 'b' }], pagination: { next: null } })
          : json({ projects: [{ id: 'a', name: 'a' }], pagination: { next: 123 } });
      },
    });
    assert.deepEqual((await client.listProjects()).map((p) => p.id), ['a', 'b']);
    assert.equal(n, 2);
  });

  it('retries 429 then succeeds', async () => {
    let n = 0;
    const client = new VercelReadOnlyClient({
      token: 't',
      fetch: async () => (++n < 2 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : json([])),
    });
    await client.listProjects();
    assert.equal(n, 2);
  });

  it('explains 403 on billing', async () => {
    const client = new VercelReadOnlyClient({ token: 't', fetch: async () => new Response('', { status: 403 }) });
    await assert.rejects(client.billingCharges('a', 'b'), /project-scoped token cannot read it/);
  });

  it('never leaks the token via inspect or JSON', () => {
    const client = new VercelReadOnlyClient({ token: 'secret-token' });
    assert.ok(!inspect(client).includes('secret-token'));
    assert.ok(!JSON.stringify(client).includes('secret-token'));
  });
});

describe('estimate (end to end, fake Vercel)', () => {
  it('produces a report from projects + billing + local package.json', async () => {
    const billing = jsonl([
      row('Active CPU', 'Hours', 10, 1.28, '2026-09-10'),
      row('Provisioned Memory', 'GB-Hrs', 200, 2.1, '2026-09-10'),
      row('Function Invocations', 'Requests', 500_000, 0.3, '2026-09-10'),
      row('Edge Requests', 'Requests', 900_000, 0.5, '2026-09-10'),
    ]);
    const client = new VercelReadOnlyClient({
      token: 't',
      fetch: async (url) => {
        const p = new URL(String(url)).pathname;
        if (p === '/v10/projects')
          return json({
            projects: [{ id: 'prj_1', name: 'shop', serverlessFunctionRegion: 'iad1', resourceConfig: { fluid: true, functionDefaultMemoryType: 'standard' } }],
          });
        if (p === '/v1/billing/charges') return new Response(billing);
        return new Response('', { status: 404 });
      },
    });
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'est-'));
    const pkgPath = join(dir, 'package.json');
    await writeFile(pkgPath, JSON.stringify({ dependencies: { next: '15.0.0', '@prisma/client': '6' }, scripts: { postinstall: 'prisma generate' } }));

    const report = await estimate({ client, project: 'shop', days: 30, packageJsonPath: pkgPath, now: new Date('2026-09-20T15:00:00Z') });
    assert.equal(report.project.region, 'iad1');
    assert.equal(report.usage.window.from, '2026-08-21T00:00:00.000Z');
    assert.equal(report.usage.window.to, '2026-09-20T00:00:00.000Z');
    assert.equal(report.recommendation.vercel.tier, 'standard');
    assert.equal(report.recommendation.confidence, 'high');
    assert.ok(report.recommendation.observed.avgActiveCpuMsPerInvocation! > 0);
    assert.equal(report.warnings.length, 0);
  });
});
