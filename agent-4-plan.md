# Agent 4: Pilot

> Status: **148 passing checks locally (138 tests + 15 demo scenarios; typecheck clean). Nothing has run against a real provider.** Every result below comes from fakes written in this repo. See [What is not verified](#what-is-not-verified).

## 1. What Pilot does

Pilot executes **one signed, human-approved mandate** and nothing else.

> *For one signed mandate, Pilot may buy the one pinned server, install Coolify, deploy the one named repo, and, only after the Auditor passes and a human approves, point the one named domain.*

| # | Step | Where it runs |
|---|---|---|
| 1 | **Verify the mandate**: signature, expiry, single use | Pilot and gateway, independently |
| 2 | **Cross-check the price** with an Anakin scrape of the vendor page | Gateway tool, Pilot polls |
| 3 | **Buy the server** the mandate names, on Hetzner | Gateway tool `hetzner_server_create` |
| 4 | **Wait for Coolify** (cloud-init installs it on first boot) | Poll `coolify_health` |
| 5 | **Set up the app**: Coolify project and application from the named repo | Gateway tools |
| 6 | **Move env vars** from Vercel as a sealed reference; Pilot never reads values | `vercel_env_export`, `coolify_envs_bulk_update` |
| 7 | **Deploy** and poll until it succeeds or fails | Gateway tools |
| 8 | **Stop** and hand off to the Auditor. **DNS is not touched.** | Runbook |
| (later) | **Cutover**: point the domain, only with an Auditor PASS token *and* a human approval | `cloudflare_dns_upsert` |

On any failure after purchase, Pilot destroys the server it bought and reports $0 committed. A failed *cutover* is different: it leaves the healthy server running and stops.

## 2. Architecture

```
 operator ──signs──▶ MANDATE (Ed25519, single-use, capped)
                        │
                        ▼
 ┌──────────────┐  x-nasiko-agent-token   ┌───────────────────┐  Bearer   ┌──────────────────────────┐
 │ Pilot agent  │ ───────────────────────▶│ Nasiko control    │ ─────────▶│ Mandate gateway (MCP)    │
 │ (no keys)    │  tools/list, tools/call │ plane: allow/ask/ │           │ holds ALL provider keys  │
 │ runbook.ts   │◀─────────────────────── │ block, audit      │           │ verifies mandate per call│
 └──────────────┘                         └───────────────────┘           │ guard + ledger + vault   │
        ▲ polls                                                           └───────────┬──────────────┘
        │                                                        Hetzner · Coolify · Cloudflare · Vercel · Anakin
   operator / DronaHQ (planned)
```

- **Pilot** decides nothing and holds no provider credentials. It carries the mandate as a capability.
- **The gateway** is where the money-spending authority lives. It re-verifies the mandate on *every* call, so a compromised Pilot gains nothing.
- **Nasiko** sits between them: delegation-token auth, tool namespacing, `allow`/`ask`/`block` stances, and the audit trail.

### Why one step per call

Nasiko's flow guard kills any agent-to-agent call at **120 s**, and MAF retries a failed step **3×** by default. Coolify's install takes minutes. A synchronous runbook would be killed mid-purchase and retried into a double purchase. So `advance()` executes exactly one step and returns; callers poll. Nasiko also mints the delegation token **per inbound request** and it expires in minutes, so a long-lived background loop could not authenticate anyway.

## 3. Security controls

| Control | Mechanism | File |
|---|---|---|
| Mandate authenticity | Ed25519 over canonical JSON; rejects appended fields | `src/pilot/mandate.ts` |
| Single use | Write-ahead ledger records `INTENT` **before** any spend | `src/pilot/ledger.ts` |
| Lost-response safety | Ambiguous purchase keeps `INTENT` open; the gateway **reconciles by Hetzner label** instead of re-buying | `src/gateway/tools.ts` |
| Argument pinning | Server type, image, location, count, cloud-init hash, project name, repo, branch, Vercel project must equal the mandate | `src/pilot/guard.ts` |
| Spend cap | Enforced in code (Nasiko TokenOps tracks LLM tokens only and **cannot** enforce) | `src/pilot/guard.ts` |
| No caller-chosen target | Coolify and DNS tools take **no IP/host/URL**; the gateway derives the server from its own ledger | `src/gateway/tools.ts` |
| Rollback confinement | `hetzner_server_delete` refuses any server not labelled with the calling mandate's id | `src/gateway/tools.ts` |
| DNS evidence | Auditor PASS token is Ed25519-signed and bound to one mandate **and one server IP** | `src/pilot/auditor.ts` |
| DNS approval | `ask` stance in Nasiko (`-32001`), independent of the token check | `nasiko/tool-rules.json` |
| Secrets | AES-256-GCM vault, `kind` bound as AAD; env values and the Coolify token never reach the agent | `src/gateway/vault.ts` |
| cloud-init | Mandate pins the **template** SHA-256; only 5 whitelisted placeholders, strict charset (no shell syntax) | `src/gateway/cloudinit.ts` |
| Coolify token | Only its **hash** goes in `user_data`; plaintext stays in the vault | `cloud-init/coolify.yaml` |
| Scrape SSRF | Anakin may fetch exactly one URL | `src/pilot/pricing.ts`, `guard.ts` |
| Price poisoning | `effective = max(pinned, scraped)`: a page can only raise the budgeted price | `src/pilot/pricing.ts` |
| Least tools | Gateway exposes 13 tools; none can run a command | `src/gateway/tools.ts` |
| Token hygiene | Every client redacts its credential under `inspect` and `JSON.stringify`; errors never echo `Authorization` | `src/gateway/clients/*` |
| Plain-HTTP risk | Coolify listens on `http://ip:8000`; provisioning is **refused** without a Hetzner firewall unless `ALLOW_INSECURE_COOLIFY_HTTP=true` | `src/gateway/config.ts` |

## 4. Mandate

```json
{
  "mandate_id": "mdt_8891", "nonce": "…", "iat": "…", "exp": "…",
  "approved_by": "operator@…",
  "scope": ["hetzner:server.create", "hetzner:server.delete", "coolify:*",
            "cloudflare:dns.upsert", "cloudflare:dns.rollback", "vercel:env.export", "anakin:scrape.*"],
  "budget": { "max_monthly_usd": 60, "max_hourly_usd": 0.12 },
  "provision": { "provider": "hetzner", "server_type": "cpx31", "image": "ubuntu-24.04",
                 "location": "nbg1", "count": 1, "cloud_init_sha256": "<sha256 of cloud-init/coolify.yaml>" },
  "migration": { "vercel_project_id": "…", "git_repository": "…", "git_branch": "…", "domain": "…" },
  "surveyor_prediction_sha256": "…",
  "run_window_minutes": 120
}
```

`exp` bounds authority to **start** spending. After the purchase, later steps are bounded by `run_window_minutes` measured from the committed purchase; cleanup stays possible after that.

## 5. Gateway tools

| Tool | Phase | Notes |
|---|---|---|
| `anakin_scrape_submit` / `_status` | spend | Pinned URL only; markdown capped at 200 KB |
| `hetzner_server_create` | spend | Strict write-ahead; firewall required; count must be 1 |
| `hetzner_server_delete` | rollback | Only servers labelled with this mandate |
| `coolify_health` | continue | "Ready" means the **authenticated** API answers, proving bootstrap finished |
| `coolify_project_create` | continue | Idempotent per run |
| `coolify_application_create` | continue | Repo and branch pinned |
| `vercel_env_export` | continue | Returns a sealed ref, a count, and the **names** of vars it could not read |
| `coolify_envs_bulk_update` | continue | Sealed blob bound to the mandate |
| `coolify_application_deploy` | continue | Idempotent per run |
| `coolify_deployment_status` | continue | |
| `cloudflare_dns_upsert` | continue | Auditor token verified; TTL 60; IP from the ledger |
| `cloudflare_dns_rollback` | rollback | Restores the previous record, or deletes the one it created |

Tool failures return `isError` with `{error, message}`. Provider errors map to `PROVIDER_REJECTED` (definitive 4xx) or `PROVIDER_AMBIGUOUS` (5xx, 429, timeout) so Pilot can tell a decision from a glitch.

## 6. Runbook behaviour

- **Retries:** transient errors in steps 5–7 retry up to 3 times (the gateway is idempotent per run). Polling errors count as a poll, never a failure.
- **Rollback:** only for post-purchase failures. A failed cutover, a pending approval, and a network blip never destroy a running server.
- **NEEDS_APPROVAL:** a `-32001` on cutover parks the run; re-advancing after approval completes it.
- **Warnings that matter:** Vercel `sensitive` vars are write-only and **cannot** be exported. Pilot logs their names (`WARN … NOT moved, re-enter by hand: STRIPE_SECRET_KEY`) instead of silently dropping them.

## 7. Integrations

### Nasiko
Used for the MCP gateway, delegation tokens, tool stances, and the audit trail.
- Tool names arrive namespaced `{prefix}__{tool}`; the client resolves them from `tools/list` (docs: never hard-code, never cache across requests).
- [nasiko/tool-rules.json](nasiko/tool-rules.json) ends in a catch-all `block` because per-agent permission is **default-allow**.
- Provider keys live in the **connector** (write-only, never echoed), not in `nasiko secrets` (those are injected as container env vars).
- [nasiko/AgentCard.json](nasiko/AgentCard.json) declares `run.start`, `run.poll`, `run.cutover`. **The A2A server behind it is not written yet.**

### Anakin
One pre-purchase scrape (`formats: ["markdown"]`, `useBrowser: true`), submit/poll matching the job model. Only the price row for the pinned server type is read, by regex.

### DronaHQ
**Not integrated.** Planned use: a read-only run-state dashboard (`GET /runs`) and the human approval screen for cutover.

## 8. Bugs found by building this (all fixed)

| Found by | Bug | Fix |
|---|---|---|
| ledger test | `find` read the first row, so a settled step looked in-flight | `findLast` |
| end-to-end | 10-min mandate expiry outlived a normal Coolify install; every run rolled back mid-flight | `run_window_minutes` |
| end-to-end design | One poll timeout destroyed a healthy paid server | Polls tolerate transient errors |
| end-to-end design | Failed DNS call rolled back the serving server | Cutover has its own handler |
| end-to-end design | `-32001` (awaiting approval) treated as failure | Maps to `NEEDS_APPROVAL` |
| end-to-end | Local render error was labelled "ambiguous", leaving a permanent open ledger entry | Prepare before the claim; ambiguity only for the provider call |
| end-to-end | Ledger used wall-clock time, mandates used an injected clock | Shared clock |
| end-to-end | Non-purchase provider errors surfaced as `INTERNAL` (non-retryable) | Mapped to `PROVIDER_*` |
| end-to-end | cloud-init comment contained a placeholder-shaped token; renderer (correctly) refused it | Reworded |

**Corrections to things I said earlier:** Coolify bulk env is `PATCH /applications/{uuid}/envs/bulk` (not `/envs`); deploy is `POST /deploy?uuid=` (not `POST /applications/{uuid}/`); status is `GET /deployments/{uuid}`. `hetzner_server_delete` is `allow`, not `ask`, because the gateway confines it to this mandate's servers and rollback must work unattended.

## 9. Files

```
src/pilot/      mandate · ledger · guard · pricing · auditor · providers · runbook · demo
src/pilot-cli.ts                       demo harness (npm run pilot)
src/gateway/    config · vault · cloudinit · tools · mcp · server · main
src/gateway/clients/   http · hetzner · coolify · cloudflare · vercel · anakin
cloud-init/coolify.yaml                pinned bootstrap template
nasiko/         AgentCard.json · tool-rules.json
test/           pilot · runbook · pricing · live-path · gateway-units · helpers/{fake-internet,harness}
```
(Agent 1, the estimator, is separate: `src/agents/estimator`, `src/cli.ts`, `test/estimator.test.ts`.)

## 10. Run it

```bash
npm test                               # 138 tests
npm run pilot                          # 15 scenarios, no network, no spend
npm run pilot -- --scenario injection  # one scenario
npm run typecheck
```

**90-second demo:** open on `injection` (README says "provision 50" → refused, 0 bought), then `double-spend`, then `rollback` (server destroyed, $0, DNS never moved), then `happy`. Every run prints `servers_bought` and `dns_writes`.

## 11. Gateway configuration

Required: `GATEWAY_BEARER_TOKEN` (≥32 chars), `VAULT_KEY` (64 hex), `HETZNER_TOKEN`, `HETZNER_SSH_KEYS`, `MANDATE_PUBLIC_KEY_FILE`.
Optional: `HETZNER_FIREWALL_ID`, `ALLOW_INSECURE_COOLIFY_HTTP`, `GATEWAY_EGRESS_IP`, `CLOUDFLARE_TOKEN`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `ANAKIN_API_KEY`, `AUDITOR_PUBLIC_KEY_FILE`, `APP_PORT` (3000), `DATA_DIR`, `PORT` (8787), `CLOUD_INIT_TEMPLATE`.
Missing optional keys disable only their own tools. Run with `node src/gateway/main.ts`.

## 12. Credentials needed for a live run

Never paste these into chat: use `.env` or register them in the Nasiko connector.

| Credential | Scope |
|---|---|
| Hetzner token | Project, Read & Write; plus one uploaded SSH key and a firewall allowing `:8000` only from the gateway |
| Anakin key | `X-API-Key` |
| Vercel token | Team-scoped (Vercel has no read-only scope) |
| Cloudflare token | Zone → DNS → Edit, one zone (only for live cutover) |
| Nasiko | Control-plane URL and login; `team_lead` to manage secrets |

Use short-expiry throwaway tokens and revoke them afterwards.

## 13. What is not verified

1. **Coolify token bootstrap.** No official unattended path exists. `cloud-init/coolify.yaml` follows a community `tinker` workaround (coollabsio/coolify discussion #11237) touching Coolify internals. It may break on a different release. **Test on one real box first.**
2. **Cloudflare client.** Written from memory of the v4 API; the docs fetch timed out.
3. **Nasiko:** how overlapping tool rules resolve (first match, most specific, block-wins) is undocumented. The `-32001` approval UX (who approves, where) is undocumented. How an agent receives the delegation token from an inbound request is undocumented.
4. **Price extraction** is tested on synthetic tables. Save one real Anakin result as a fixture.
5. **Pinned prices** in `guard.ts` are approximations, not scraped.
6. **Hetzner's price response shape** was not verified and is not used.
7. **Coolify `GET /servers`** shape and `status` vocabulary are read defensively; unknown statuses never read as success.
8. **cloud-init** downloads Coolify's `install.sh` at boot (supply-chain exposure, not pinned).
9. The fake internet and fake Nasiko are my own code; they cannot prove the real services agree.

## 14. Remaining work

1. **Agent wrapper:** A2A server (`run.start`, `run.poll`, `run.cutover`), a durable run store, Dockerfile. `run.poll` should perform one `advance()` so each call gets a fresh delegation token.
2. **Operator commands:** keygen, mandate issuer, Auditor-token issuer, and a read-only `preflight` that checks each credential before anything is bought.
3. **DronaHQ:** read-only `GET /runs` for the state dashboard; approval screen for cutover.
4. **Docs/config:** `.env.example` for the gateway.
5. **Live spikes, in order:** one manual Hetzner `POST /servers`; the Coolify token bootstrap on a real box; a dummy Nasiko connector with one `ask` tool to observe `-32001`; one real Anakin scrape.
