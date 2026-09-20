# varsiko-2.0

## Agent 1: Estimator

Sizes a Vercel project from real usage instead of manual traffic inputs. It is deterministic (no LLM) and returns a structured `EstimatorReport` for downstream agents.

1. **Usage**: `GET /v1/billing/charges` (FOCUS v1.3 JSONL, daily) filtered to the project: Active CPU, Provisioned Memory (GB-hrs), legacy Function Duration, Invocations, Fast Data Transfer, Edge Requests, Image Optimization.
2. **Workload**: `package.json` from the linked GitHub repo (or `--package-json`), scanned for heavy runtime dependencies (Prisma, sharp, Puppeteer/Playwright, FFmpeg, ML runtimes, ...) plus build-config checks (e.g. Prisma without `prisma generate`).
3. **Recommendation**: Vercel Function tier (Standard 2 GB/1 vCPU or Performance 4 GB/2 vCPU), a dedicated-host equivalent, a what-if monthly cost delta from observed $/unit, and a confidence level.

```
cp .env.example .env      # fill in VERCEL_TOKEN
npm run estimate -- --project my-app --days 30
npm run estimate -- --project my-app --dump-services   # verify billing name classification
npm test
```

### Token

Vercel has **no read-only token scope** (Full Account, Team, or Project; all can write). The client therefore only exposes `GET` and redacts the token from logs. Billing data is team-level, so use a **Team-scoped** token with a short expiry; a project-scoped token is refused by the billing endpoint. The token is read from `VERCEL_TOKEN` only, never from argv.

### Known limits

- Billing `ServiceName`/`ConsumedUnit` strings are matched from Vercel's documented metric names, not a captured response. Run `--dump-services` once against a real team; unmatched lines are reported, not dropped.
- Memory costs per dependency and the CPU-bound (150 ms/invocation), burst (×3) and headroom constants in `manifest.ts` / `sizing.ts` are heuristics, not measurements.
- SSR vs static cannot be read from `package.json`; the invocations-per-edge-request ratio is used instead.
