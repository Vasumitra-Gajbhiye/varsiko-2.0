# Porter

**Severance agent 03.** Rewrites a Vercel-coupled Next.js app so it runs anywhere, and hands you the change as a diff you can actually review.

Porter does not "try to make it work elsewhere". It finds every place the app depends on Vercel, rewrites the ones it can rewrite safely, and *tells you about the ones it can't* — because the failure mode that ruins a migration is not the build that breaks, it's the thing that keeps working and quietly stops being correct.

```bash
npm install
npm run demo          # plan the bundled fixture, write nothing
npx tsx src/cli.ts port ./my-app
```

## What it finds

| Coupling | Off-platform, if you do nothing |
|---|---|
| `@vercel/blob` | **Runtime break.** No token is issued; every upload, delete and list fails. |
| `@vercel/kv` | **Runtime break.** The Upstash REST connection does not exist. |
| `vercel.json` crons | **Silent drift.** Routes still answer. Nothing calls them. The digest just stops arriving. |
| ISR / `revalidate` | **Silent drift.** Each replica keeps its own `.next/cache`, so users see different versions of a page and `revalidatePath` only clears one of them. |
| `@vercel/functions` | **Silent drift.** `geolocation()` returns `undefined` instead of throwing, so geo rules quietly stop applying. |
| `@vercel/edge-config` | **Runtime break.** No self-hosted equivalent; every flag read fails. |
| `runtime = 'edge'` | Keeps a restricted API surface with no edge network behind it. |
| Analytics / Speed Insights | Beacons to routes only Vercel serves. |
| No Dockerfile | **Build break.** Nothing in the repo says how to build or run the app anywhere else. |

## What it does about it

- **Blob → S3.** A shim exporting the same functions with the same return shapes, so call sites don't change. Client-direct uploads are replaced as a pair — presigned PUT plus an HMAC-signed completion callback — because replacing one half leaves a browser asking for a token nobody mints.
- **KV → Redis.** A shim that reproduces Upstash's auto-JSON serialisation. A plain `ioredis` swap would store `[object Object]` without throwing, and surface days later as `undefined` field reads.
- **Cron → a scheduler that actually runs.** The schedule is extracted to `infra/porter-schedules.json` and paired with a zero-dependency runner (UTC, per-minute Redis lock so only one replica fires each job).
- **ISR → shared Redis cache.** Your `revalidate` values are left alone — they keep their meaning, now enforced across replicas instead of per-container. `revalidatePath` works because the handler reads the tags Next.js puts in the response header, not just `ctx.tags`.
- **Edge pins → Node.** Removed where they cost something, kept where removing them would change behaviour.
- **A way to deploy.** Multi-stage Dockerfile for `output: 'standalone'` (non-root, healthcheck) and a compose stack containing only the services this app actually needs.

Every generated file is stamped with what wrote it and what it replaces.

## Honesty rules

These are the parts that make the output trustworthy, and they're enforced by tests:

- **A step only claims a finding it actually fixed.** If the cache handler couldn't be wired into a computed `next.config`, the ISR finding stays in the report rather than being marked done.
- **Anything Porter can't fix lands in "Needs a human"** — never dropped.
- **Re-running is a no-op.** Port twice, get an empty diff; re-scan, get zero findings.
- **`--dry-run` does the real work on a throwaway copy**, so the diff it shows is the diff you'd get, and your repo is untouched.
- **Caveats are loud**, including the ones Porter cannot act on: existing blobs aren't copied, KV data isn't migrated, `remotePatterns` needs your new CDN host.

## Commands

```bash
porter scan <repo> [--pretty]     # inventory only
porter port <repo> [--dry-run]    # rewrite, print the diff
npm test                          # 26 tests
npm start                         # A2A server on :8000
```

`port` writes `.porter/plan.json`, `.porter/plan.md` and `.porter/porter.diff`.

## As a Nasiko agent

Identity is `AgentCard.json` `name`: **severance-porter**. Speaks A2A over JSON-RPC; card at `/.well-known/agent-card.json`.

On Nasiko, Porter fetches a GitHub tarball (or uses `fixtures/victim-app` when `PORTER_OFFLINE=1`), re-scans the tree, and dry-runs a port. It forwards the Surveyor `severance.capacity_spec/v1` unchanged plus a `severance.port_plan/v1` artifact. It does not push branches or open PRs.

Surveyor's `lockin_detail` and Porter's `LockInInventory` are related but **not the same schema**. Porter's scan is source of truth for what it rewrites.

```bash
PORTER_OFFLINE=1 npm start
# then send a capacity_spec JSON via A2A message/send
```

## Status

Verified end to end on `fixtures/victim-app`: ports clean, is idempotent, and the result passes `tsc --noEmit`. The generated app reaches the prerender stage of `next build`, where it correctly fails on a page that calls Redis at build time — which is the documented caveat, not a bug in the output. The ISR cache handler is exercised manually rather than in CI; its test is the one piece not yet wired up.
