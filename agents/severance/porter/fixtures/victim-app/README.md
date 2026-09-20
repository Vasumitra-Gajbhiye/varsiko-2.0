# victim-app

A deliberately Vercel-coupled Next.js 15 storefront. This is Porter's fixture target:
it exists so the migration has something real to rewrite, and so the diff on stage is
a diff of an application, not a toy.

Lock-in it carries on purpose:

| # | Coupling | Where |
|---|----------|-------|
| 1 | `next/image` against Vercel's optimizer | `app/page.tsx`, `app/products/[slug]/page.tsx`, `components/Hero.tsx`, `next.config.mjs` |
| 2 | `@vercel/blob` server + client uploads | `lib/storage.ts`, `app/api/upload/route.ts`, `app/gallery/page.tsx` |
| 3 | `@vercel/kv` rate limit, sessions, sorted sets | `lib/rate-limit.ts` |
| 4 | `vercel.json` crons | `vercel.json`, `app/api/cron/*` |
| 5 | Edge middleware + edge route handler | `middleware.ts`, `app/api/geo/route.ts` |
| 6 | ISR time-based revalidate | `app/page.tsx`, `app/products/[slug]/page.tsx`, `app/api/revalidate/route.ts` |
| 7 | `@vercel/functions`, `@vercel/edge-config`, `@vercel/analytics`, `@vercel/speed-insights` | `middleware.ts`, `app/layout.tsx`, `app/api/geo/route.ts` |

Run `porter scan .` from this directory to see the inventory Porter builds from it.
