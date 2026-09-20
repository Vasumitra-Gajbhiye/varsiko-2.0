import type { Blast, LockInKind } from './schema.js';

/**
 * The detection table. Kept as data rather than code so the inventory is
 * auditable: a reviewer can read this file and know exactly what Porter
 * looks for and what it claims each finding costs you off-platform.
 */

export type ImportRule = {
  /** Exact module specifier, or a prefix when `prefix` is true. */
  specifier: string;
  prefix?: boolean;
  kind: LockInKind;
  blast: Blast;
  title: string;
  why: string;
  confidence: number;
};

export const IMPORT_RULES: ImportRule[] = [
  {
    specifier: '@vercel/blob',
    prefix: true,
    kind: 'blob-storage',
    blast: 'runtime-break',
    title: 'Blob storage is Vercel-hosted',
    why:
      '`@vercel/blob` talks to Vercel Blob over a `BLOB_READ_WRITE_TOKEN` scoped to the ' +
      'Vercel project. Off-platform the token is not issued and every `put`/`del`/`list` ' +
      'call fails at runtime. Uploads are usually the first thing a user notices.',
    confidence: 0.98,
  },
  {
    specifier: '@vercel/kv',
    kind: 'kv-store',
    blast: 'runtime-break',
    title: 'Key-value store is Vercel-hosted',
    why:
      '`@vercel/kv` is a thin client over Upstash Redis reached by REST, configured from ' +
      '`KV_REST_API_URL`/`KV_REST_API_TOKEN`. The package is deprecated in favour of ' +
      'marketplace integrations, and off-platform the connection simply does not exist.',
    confidence: 0.98,
  },
  {
    specifier: '@vercel/functions',
    kind: 'platform-sdk',
    blast: 'silent-drift',
    title: 'Request geolocation comes from Vercel edge headers',
    why:
      '`geolocation()` and `ipAddress()` read `x-vercel-ip-*` headers that only Vercel\'s ' +
      'edge injects. Off-platform they do not throw — they return `undefined`, so geo ' +
      'routing and region blocks quietly stop working while the app looks healthy.',
    confidence: 0.95,
  },
  {
    specifier: '@vercel/edge-config',
    kind: 'platform-sdk',
    blast: 'runtime-break',
    title: 'Feature flags read from Vercel Edge Config',
    why:
      'Edge Config is a Vercel-only read-optimised store addressed by an `EDGE_CONFIG` ' +
      'connection string. There is no self-hosted equivalent, so every flag read fails.',
    confidence: 0.97,
  },
  {
    specifier: '@vercel/postgres',
    kind: 'platform-sdk',
    blast: 'runtime-break',
    title: 'Database client is the Vercel Postgres wrapper',
    why:
      '`@vercel/postgres` is a Neon-backed wrapper keyed on `POSTGRES_URL` provisioned by ' +
      'Vercel. It is replaceable by `pg` or `postgres` against any Postgres, but the ' +
      'import and the connection bootstrap both have to change.',
    confidence: 0.9,
  },
  {
    specifier: '@vercel/analytics',
    prefix: true,
    kind: 'platform-sdk',
    blast: 'cosmetic',
    title: 'Web analytics beacons to Vercel',
    why:
      'The `<Analytics />` beacon posts to `/_vercel/insights`, a route only Vercel serves. ' +
      'Off-platform it 404s on every page view: harmless, noisy, and dead weight in the bundle.',
    confidence: 0.99,
  },
  {
    specifier: '@vercel/speed-insights',
    prefix: true,
    kind: 'platform-sdk',
    blast: 'cosmetic',
    title: 'Speed Insights beacons to Vercel',
    why:
      'Same shape as Web Analytics: a client beacon to `/_vercel/speed-insights` that does ' +
      'not exist off-platform. Replace with an OTel/RUM collector or drop it.',
    confidence: 0.99,
  },
  {
    specifier: '@vercel/otel',
    kind: 'platform-sdk',
    blast: 'silent-drift',
    title: 'Tracing is wired to Vercel OTel defaults',
    why:
      '`registerOTel()` auto-configures an exporter pointing at Vercel\'s collector. ' +
      'Off-platform traces are produced and dropped — the worst failure mode for ' +
      'observability, because the dashboards stay empty without erroring.',
    confidence: 0.9,
  },
];

export type ConfigRule = {
  kind: LockInKind;
  blast: Blast;
  title: string;
  why: string;
  confidence: number;
};

export const CONFIG_RULES: Record<string, ConfigRule> = {
  'vercel.json:crons': {
    kind: 'cron',
    blast: 'silent-drift',
    title: 'Scheduled jobs are declared in vercel.json',
    why:
      'The `crons` array is read by Vercel\'s scheduler and by nothing else. Off-platform ' +
      'the file is inert: the routes still exist and respond, but nothing ever calls them. ' +
      'Nothing errors. The digest just stops arriving.',
    confidence: 1,
  },
  'middleware:edge-runtime': {
    kind: 'edge-middleware',
    blast: 'silent-drift',
    title: 'Middleware is pinned to the Edge runtime',
    why:
      "`config.runtime = 'edge'` selects the Edge runtime. Self-hosted, Next.js still runs " +
      'middleware in its own edge sandbox inside the Node server, so the pin keeps the ' +
      'restricted API surface (no `fs`, `net`, most native modules) for no benefit, and there ' +
      'is no edge network behind it. The pin is harmless to remove; what actually breaks ' +
      'off-platform is the Vercel-only helpers such a middleware usually imports, which are ' +
      'reported as separate platform-sdk findings.',
    confidence: 0.92,
  },
  'route:edge-runtime': {
    kind: 'edge-runtime',
    blast: 'silent-drift',
    title: 'Route pinned to the Edge runtime',
    why:
      '`export const runtime = \'edge\'` selects the Edge runtime. Self-hosted, Next.js ' +
      'still honours it and narrows the API surface for no benefit — there is no edge ' +
      'network to run on. Node is strictly better here.',
    confidence: 0.95,
  },
  'isr:revalidate': {
    kind: 'isr',
    blast: 'silent-drift',
    title: 'ISR and on-demand revalidation use the default filesystem cache',
    why:
      'Self-hosted, ISR writes rendered pages to `.next/cache` on local disk. With one ' +
      'container that works. With more than one, each replica keeps its own copy, so ' +
      'users see different versions of the same page and `revalidatePath` only clears the ' +
      'replica that received the call. Containers are ephemeral, so a redeploy drops the ' +
      'cache entirely.',
    confidence: 0.85,
  },
  'next.config:images': {
    kind: 'image-optimization',
    blast: 'silent-drift',
    title: 'Image optimization runs on Vercel\'s optimizer',
    why:
      '`next/image` on Vercel is served by their optimizer and CDN, billed per source ' +
      'image. Self-hosted, Next.js optimizes in-process with sharp — which works, but ' +
      'puts CPU and memory on your box, caches to local disk, and leaves the endpoint ' +
      'open as an amplification target if `remotePatterns` is loose.',
    confidence: 0.88,
  },
  'build:no-container': {
    kind: 'build-output',
    blast: 'build-break',
    title: "No container build: the only build recipe is Vercel's",
    why:
      'Vercel builds and runs the app from platform-managed build output; nothing in this ' +
      'repository says how to build an image or start the server anywhere else. Off-platform ' +
      'there is no deploy target to point a scheduler, proxy or orchestrator at.',
    confidence: 0.9,
  },
};
