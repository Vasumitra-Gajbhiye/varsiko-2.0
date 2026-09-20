import type { FocusRow, MetricKey, MetricTotals, UsageSummary } from './types.ts';

/**
 * ServiceName -> metric. Order matters (first match wins).
 * NOTE: these patterns are written from Vercel's documented metric names, not from a
 * captured API response. Run the CLI with --dump-services against a real team to confirm.
 */
const CLASSIFIERS: [RegExp, MetricKey][] = [
  [/active cpu/, 'activeCpuHours'],
  [/provisioned memory/, 'provisionedMemoryGbHours'],
  [/function (duration|execution)/, 'functionDurationGbHours'],
  [/invocation/, 'invocations'],
  [/fast origin transfer/, 'fastOriginTransferGb'],
  [/fast data transfer|edge network.*(bandwidth|transfer)|bandwidth/, 'fastDataTransferGb'],
  [/edge request/, 'edgeRequests'],
  [/image.*transformation/, 'imageTransformations'],
  [/image.*cache read/, 'imageCacheReads'],
  [/image.*cache write/, 'imageCacheWrites'],
];

export function classifyService(serviceName: string): MetricKey | null {
  const s = serviceName.toLowerCase();
  return CLASSIFIERS.find(([re]) => re.test(s))?.[1] ?? null;
}

type Dimension = 'hours' | 'gbHours' | 'gb' | 'count';

const DIMENSION: Record<MetricKey, Dimension> = {
  activeCpuHours: 'hours',
  provisionedMemoryGbHours: 'gbHours',
  functionDurationGbHours: 'gbHours',
  invocations: 'count',
  fastDataTransferGb: 'gb',
  fastOriginTransferGb: 'gb',
  edgeRequests: 'count',
  imageTransformations: 'count',
  imageCacheReads: 'count',
  imageCacheWrites: 'count',
};

/** Returns the quantity in the metric's canonical unit, or null if the unit is unrecognised. */
export function normalizeQuantity(metric: MetricKey, quantity: number, unit: string | null): number | null {
  const u = (unit ?? '').toLowerCase().replace(/[\s_]/g, '');
  switch (DIMENSION[metric]) {
    case 'hours':
      if (/^(h|hr|hrs|hour|hours)$/.test(u)) return quantity;
      if (/^(m|min|mins|minute|minutes)$/.test(u)) return quantity / 60;
      if (/^(s|sec|secs|second|seconds)$/.test(u)) return quantity / 3600;
      if (/^(ms|millisecond|milliseconds)$/.test(u)) return quantity / 3_600_000;
      return null;
    case 'gbHours':
      if (/^gb-?(h|hr|hrs|hour|hours)$/.test(u)) return quantity;
      if (/^mb-?(h|hr|hrs|hour|hours)$/.test(u)) return quantity / 1024;
      if (/^gb-?(s|sec|secs|second|seconds)$/.test(u)) return quantity / 3600;
      return null;
    case 'gb':
      if (/^(gb|gib)$/.test(u)) return quantity;
      if (/^(tb|tib)$/.test(u)) return quantity * 1024;
      if (/^(mb|mib)$/.test(u)) return quantity / 1024;
      if (/^(b|byte|bytes)$/.test(u)) return quantity / 1024 ** 3;
      return null;
    case 'count':
      if (/million|^1m$|^m$/.test(u)) return quantity * 1e6;
      if (/thousand|^1k$|^k$/.test(u)) return quantity * 1e3;
      return quantity; // "requests", "units", "invocations", "count", ...
  }
}

function parseTags(tags: FocusRow['Tags']): Record<string, string> {
  if (!tags) return {};
  if (typeof tags === 'object') return tags;
  try {
    const parsed: unknown = JSON.parse(tags);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function tag(tags: Record<string, string>, key: string): string | undefined {
  const k = Object.keys(tags).find((x) => x.toLowerCase() === key.toLowerCase());
  return k ? tags[k] : undefined;
}

export async function* readJsonl(body: ReadableStream<Uint8Array>): AsyncGenerator<FocusRow> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line) as FocusRow;
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield JSON.parse(buf) as FocusRow;
}

export interface SummarizeOptions {
  from: string;
  to: string;
  /** Restrict to one project by id or name (matched against the Tags on each row). */
  project?: { id: string; name: string };
}

export async function summarizeCharges(
  rows: AsyncIterable<FocusRow> | Iterable<FocusRow>,
  opts: SummarizeOptions,
): Promise<UsageSummary> {
  const perDay = new Map<MetricKey, Map<string, number>>();
  const cost = new Map<MetricKey, number>();
  const unclassified = new Map<string, UsageSummary['unclassified'][number]>();
  const seen = new Map<string, { service: string; unit: string | null }>();
  const warnings: string[] = [];
  const badUnits = new Set<string>();
  let matchedRows = 0;
  let rowsWithProjectTag = 0;

  for await (const row of rows) {
    if (opts.project) {
      const tags = parseTags(row.Tags);
      const id = tag(tags, 'ProjectId');
      const name = tag(tags, 'ProjectName');
      if (id || name) rowsWithProjectTag++;
      if (id !== opts.project.id && name !== opts.project.name) continue;
    }
    matchedRows++;
    if (row.ChargeCategory !== 'Usage') continue;

    const unit = row.ConsumedUnit ?? null;
    seen.set(`${row.ServiceName}|${unit}`, { service: row.ServiceName, unit });
    const metric = classifyService(row.ServiceName);
    const rawQty = row.ConsumedQuantity ?? 0;

    if (!metric) {
      const key = `${row.ServiceName}|${unit}`;
      const u = unclassified.get(key) ?? { service: row.ServiceName, unit, quantity: 0, effectiveCost: 0 };
      u.quantity += rawQty;
      u.effectiveCost += row.EffectiveCost;
      unclassified.set(key, u);
      continue;
    }

    let qty = normalizeQuantity(metric, rawQty, unit);
    if (qty === null) {
      badUnits.add(`${row.ServiceName} [${unit}]`);
      qty = rawQty;
    }
    const day = row.ChargePeriodStart.slice(0, 10);
    const days = perDay.get(metric) ?? new Map<string, number>();
    days.set(day, (days.get(day) ?? 0) + qty);
    perDay.set(metric, days);
    cost.set(metric, (cost.get(metric) ?? 0) + row.EffectiveCost);
  }

  if (badUnits.size) {
    warnings.push(`Unrecognised units, quantities used as-is: ${[...badUnits].join('; ')}`);
  }
  if (opts.project && matchedRows === 0) {
    warnings.push(
      rowsWithProjectTag === 0
        ? 'No billing rows carried a project tag; per-project usage is unavailable.'
        : `No billing rows matched project "${opts.project.name}" in this window.`,
    );
  }

  const metrics: UsageSummary['metrics'] = {};
  for (const [metric, days] of perDay) {
    const values = [...days.values()];
    const totals: MetricTotals = {
      quantity: values.reduce((a, b) => a + b, 0),
      effectiveCost: cost.get(metric) ?? 0,
      peakDayQuantity: Math.max(...values),
      activeDays: values.length,
    };
    metrics[metric] = totals;
  }

  const days = Math.max(1, Math.round((Date.parse(opts.to) - Date.parse(opts.from)) / 86_400_000));
  return {
    window: { from: opts.from, to: opts.to, days },
    metrics,
    unclassified: [...unclassified.values()],
    seenServices: [...seen.values()],
    warnings,
  };
}
