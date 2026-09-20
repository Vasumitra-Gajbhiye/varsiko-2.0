# Agent 4: Pilot

> Status: **308 passing checks locally (289 tests + 19 demo scenarios; typecheck clean). Operator commands (Phase A) and the handoff lane are built. Nothing has run against a real provider.** Every result below comes from fakes written in this repo. See [What is not verified](#what-is-not-verified).

## 1. What Pilot does

Pilot executes **one signed, human-approved mandate** and nothing else.

> *For one signed mandate, Pilot may buy the one pinned server, install Coolify, deploy the one named repo, and, only after the Auditor passes and a human approves, point the one named domain.*

### Two lanes

A mandate's `provision.provider` decides who buys the server. Everything after boot is identical.

| Lane | When | Who pays | What Pilot does |
|---|---|---|---|
| `hetzner` (automated) | Pilot has a tested adapter and credentials for the vendor | Pilot, inside the mandate's cap | Buys, boots, deploys (steps 1-8 below) |
| `handoff` | No adapter, but the vendor supports cloud-init on an allowed Ubuntu image | **The human**, on the vendor's site | Parks in `AWAITING_HUMAN_PURCHASE`, then continues from boot (steps 4-8) |

`routeCandidate` ([src/pilot/candidates.ts](src/pilot/candidates.ts)) sorts each VPS candidate Agent 2 proposes into `automated`, `handoff` or `unsupported`, treating every field as untrusted scraped text. `AUTOMATED_VENDORS` is the registry a second automated vendor would plug into.

In the handoff lane an operator runs `handoff card` (renders the task card and the cloud-init the human pastes at the vendor) and then `handoff register --ip <ipv4>`. Pilot **reads** that address from the gateway; it can never supply one. Pilot still decides nothing and holds no credentials.

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

On any failure after purchase, Pilot destroys the server it bought and reports $0 committed. A failed *cutover* is different: it leaves the healthy server running and stops. **A handoff run destroys nothing at all** — Pilot did not buy the server — it stops with `next_owner = "operator: cancel the server at <vendor>"`, and still reverts DNS if it had changed any.

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
   operator / DronaHQ (planned)                                               ▲
                                                                              │ Bearer GATEWAY_OPERATOR_TOKEN
                                                              ┌───────────────┴──────────────┐
                                                              │ operator CLI (npm run handoff)│
                                                              │ card · register — handoff lane│
                                                              └──────────────────────────────┘
```

- **Pilot** decides nothing and holds no provider credentials. It carries the mandate as a capability.
- **The gateway** is where the money-spending authority lives. It re-verifies the mandate on *every* call, so a compromised Pilot gains nothing.
- **Nasiko** sits between them: delegation-token auth, tool namespacing, `allow`/`ask`/`block` stances, and the audit trail.
- **The operator path** is a second credential on the same gateway, outside Nasiko. `GATEWAY_OPERATOR_TOKEN` reaches `handoff_prepare` and `handoff_register` and nothing else; the agent bearer cannot see or call them (`FORBIDDEN_ROLE`), and the operator bearer cannot buy. The IP of a human-bought server is the one input that comes from a person, and the gateway sends its Coolify token and every migrated env var there — so it needs its own credential, not Pilot's.

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
| Least tools | Gateway exposes 14 tools to the agent and 2 to the operator; none can run a command | `src/gateway/tools.ts` |
| Token hygiene | Every client redacts its credential under `inspect` and `JSON.stringify`; errors never echo `Authorization` | `src/gateway/clients/*` |
| Plain-HTTP risk | Coolify listens on `http://ip:8000`; provisioning is **refused** without a Hetzner firewall unless `ALLOW_INSECURE_COOLIFY_HTTP=true` | `src/gateway/config.ts` |
| Role split (handoff) | Two bearers on one gateway. `tools/list` and `tools/call` are filtered by role; the agent cannot prepare cloud-init or register a server | `src/gateway/server.ts`, `mcp.ts` |
| Registered-address validation | Only a public IPv4 unicast address is accepted: loopback, RFC 1918, link-local (incl. `169.254.169.254`), CGNAT, multicast, reserved, IPv6, hostnames and ports are refused. Otherwise registration is an SSRF primitive into the gateway's network | `src/gateway/ip.ts` |
| Cross-provider refusal | `hetzner:*` tools refuse a handoff mandate and `handoff:*` tools refuse a hetzner one (`WRONG_PROVIDER`), in the guard **and** in each tool | `src/pilot/guard.ts`, `tools.ts` |
| Untrusted scraped text | Vendor, plan and region are charset- and length-restricted at `verifyMandate`, and the card refuses to render a value carrying a newline or backtick | `src/pilot/mandate.ts`, `src/cli/handoff.ts` |
| No-destroy (handoff) | `rollback()` never deletes a server Pilot did not buy | `src/pilot/runbook.ts` |

**Two controls are weaker in the handoff lane, by construction:**

- **The spend cap is not enforceable.** The human pays at the vendor's checkout. `expected_monthly_usd` is advisory: it is pinned in the mandate and printed on the card with "UNVERIFIED", and nothing can check what was actually charged.
- **Argument pinning stops at the card.** Vendor, plan, region, image and the cloud-init hash are pinned in the signed mandate and rendered deterministically onto the card, but we cannot observe the vendor's checkout. A human who buys the wrong plan gets a working migration onto the wrong server.

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

For the handoff lane, `provision` is instead:

```json
{ "provider": "handoff", "vendor": "contabo", "plan": "cloud-vps-10", "region": "eu-central",
  "image": "ubuntu-24.04", "expected_monthly_usd": 5.5, "source_url": "https://…",
  "count": 1, "cloud_init_sha256": "<sha256 of cloud-init/coolify.yaml>" }
```

with scope `["handoff:prepare", "handoff:register", "handoff:status", "coolify:*", …]` and **no** `hetzner:` or `anakin:` entry. `verifyMandate` rejects an unknown `provider` (`BAD_PROVIDER`), and for `handoff` a bad charset, an image outside `ubuntu-22.04`/`ubuntu-24.04`, a price outside $1-$500, a non-https `source_url` or `count != 1` (`BAD_PROVISION`) — without echoing the offending value.

`exp` bounds authority to **start** spending. After the purchase, later steps are bounded by `run_window_minutes` measured from the committed purchase; cleanup stays possible after that. A handoff mandate defaults to a **24 h** `exp` (max 72 h), because a person has to buy a server; registration is checked against `exp`, and the run window then runs from **registration**.

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
| `handoff_prepare` **(operator)** | spend | Mints the Coolify secrets and renders the cloud-init **to the operator only** (it carries the root password). Idempotent; no ledger claim |
| `handoff_register` **(operator)** | spend | Validates the address, requires the tcp/8000 attestation, then writes the `P2` COMMITTED row `{server_id: "handoff:<ip>", ip, handoff: true}`. Re-registering the same IP is idempotent; a different one is `ALREADY_REGISTERED`; another run is `REPLAY` |
| `handoff_status` (agent) | continue | Read-only `{registered, ip?, server_id?}`. How Pilot learns the address: it is read, never supplied. "Nothing registered yet" is a normal answer, not an error |

Registration writes the same `P2` row the automated purchase writes, so `target()`, the run window, replay protection and every downstream tool work unchanged.

Tool failures return `isError` with `{error, message}`. Provider errors map to `PROVIDER_REJECTED` (definitive 4xx) or `PROVIDER_AMBIGUOUS` (5xx, 429, timeout) so Pilot can tell a decision from a glitch.

## 6. Runbook behaviour

- **Retries:** transient errors in steps 5–7 retry up to 3 times (the gateway is idempotent per run). Polling errors count as a poll, never a failure.
- **Rollback:** only for post-purchase failures. A failed cutover, a pending approval, and a network blip never destroy a running server.
- **NEEDS_APPROVAL:** a `-32001` on cutover parks the run; re-advancing after approval completes it.
- **AWAITING_HUMAN_PURCHASE:** a handoff run parks at `P2H_AWAIT_PURCHASE` and re-polls on each `advance()`; `run()` treats the status as terminal so a loop parks instead of spinning, and `live --resume` reopens it. The mandate's `exp` is the deadline (no poll counter): if nobody registers, the run fails `EXPIRED` with nothing to clean up. A registration made just before `exp` is still honoured if the poll lands just after.
- **No-destroy:** `rollback()` never deletes a handoff server. Boot polling is also more patient in that lane (60 polls, vs 20): the box was provisioned by a person at a vendor whose boot time we have never measured.
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
src/pilot/      mandate · ledger · guard · pricing · auditor · providers · runbook · candidates · demo
src/pilot-cli.ts                       demo harness (npm run pilot)
src/gateway/    config · vault · cloudinit · ip · tools · mcp · server · main
src/gateway/clients/   http · hetzner · coolify · cloudflare · vercel · anakin
src/cli/        keygen · mandate · auditor-token · preflight · live · handoff · vault · io   (operator commands)
cloud-init/coolify.yaml                pinned bootstrap template
nasiko/         AgentCard.json · tool-rules.json
test/           pilot · runbook · pricing · live-path · gateway-units · gateway-main · handoff-{mandate,gateway,runbook} · cli-* · helpers/{fake-internet,harness,handoff,cli}
```
(Agent 1, the estimator, is separate: `src/agents/estimator`, `src/cli.ts`, `test/estimator.test.ts`.)

## 10. Run it

```bash
npm test                               # 289 tests (1 skipped on Windows)
npm run pilot                          # candidate routing + 19 scenarios, no network, no spend
npm run pilot -- --scenario injection  # one scenario
npm run typecheck
```

### Operator commands (all read `.env` if present; none print a secret)

```bash
npm run keygen                         # Ed25519 keys in .local/keys + suggested VAULT_KEY / bearer
npm run mandate -- --server-type cpx31 --location nbg1 --repo owner/name --vercel-project prj_x   --domain app.example.com --max-monthly 30 --approved-by you@example.com   # add --no-dns to drop DNS
npm run preflight -- --mandate .local/mandates/<id>.json   # read-only credential check; --spend-anakin uses 1 scrape
npm run gateway                        # the MCP gateway (needs .env, see section 11)
npm run live -- --mandate <file> --run-id run_1 [--stop-after boot] [--resume]   # direct mode, spends money
npm run live -- --cleanup --mandate <file> --run-id run_1
npm run auditor-token -- --mandate-file <file> --server-ip <ip>  # then: live --cutover --auditor-token <file>
npm run vault -- put-coolify-token --mandate-id <id>   # token on STDIN; fallback if the tinker bootstrap fails
```

**Handoff lane** (a human buys the server; needs `GATEWAY_OPERATOR_TOKEN`, not the agent bearer):

```bash
npm run mandate -- --handoff --vendor contabo --plan cloud-vps-10 --region eu-central   --expected-monthly 5.5 --source-url https://… --image ubuntu-24.04   --repo owner/name --vercel-project prj_x --domain app.example.com --approved-by you@example.com
npm run live -- --mandate <file> --run-id run_1        # parks at AWAITING_HUMAN_PURCHASE, spends nothing
npm run handoff -- card --mandate <file> --run-id run_1    # writes .local/handoff/<id>.card.md + .cloud-init.yaml (0600), prints PATHS ONLY
#   → give the human the card: buy the plan, paste the cloud-init into the vendor's user-data field,
#     restrict tcp/8000 to the gateway, then tell the operator the address
npm run handoff -- register --mandate <file> --run-id run_1 --ip <ipv4> --port-8000-restricted
npm run live -- --mandate <file> --run-id run_1 --resume   # continues to DEPLOYED
```
The rendered cloud-init carries the Coolify root password in plaintext, so it goes to the operator only: `handoff card` prints paths, never contents, and `.local/` is git-ignored. `register` echoes the address back and asks before it commits, because the gateway will send its Coolify token and every migrated env var there.
Behaviour worth knowing: `live` needs a `yes` (or `--yes`) before it spends, defaults to about 15 minutes of boot polling (the runbook's own 20 polls would destroy a healthy box mid-install), and on `--resume` releases this run's open agent-side purchase INTENT so the gateway reconciles by label (without this a persisted ledger makes resume fail with `IN_FLIGHT`). `mandate` turns `owner/name` into `https://github.com/owner/name` (Coolify's public-app endpoint is believed to want a URL; unverified). `--stop-after deploy` means "deployment queued", not "deployment succeeded".

**90-second demo:** open on `injection` (README says "provision 50" → refused, 0 bought), then `double-spend`, then `rollback` (server destroyed, $0, DNS never moved), then `happy`. Every run prints `servers_bought` and `dns_writes`.

## 11. Gateway configuration

Required: `GATEWAY_BEARER_TOKEN` (≥32 chars), `VAULT_KEY` (64 hex), `HETZNER_TOKEN`, `HETZNER_SSH_KEYS`, `MANDATE_PUBLIC_KEY_FILE`.
Optional: `GATEWAY_OPERATOR_TOKEN` (≥32 chars, must differ from `GATEWAY_BEARER_TOKEN`; unset disables the handoff operator tools), `HETZNER_FIREWALL_ID`, `ALLOW_INSECURE_COOLIFY_HTTP`, `GATEWAY_EGRESS_IP`, `CLOUDFLARE_TOKEN`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `ANAKIN_API_KEY`, `AUDITOR_PUBLIC_KEY_FILE`, `APP_PORT` (3000), `DATA_DIR`, `PORT` (8787), `CLOUD_INIT_TEMPLATE`.
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
10. **cloud-init on third-party vendors.** Each vendor's user-data field, image names and boot behaviour differ, and the Coolify bootstrap is unverified even on Hetzner. `supports_cloud_init` is Agent 2's claim; Pilot cannot check it.
11. **Human error in the handoff lane.** The human can buy a different plan, skip the firewall, or paste an edited cloud-init. Only the last is caught, and indirectly: the Coolify token works only on a box that ran the exact template, so an edited file means `coolify_health` never turns ready.
12. **A wrong registered IP.** If an operator registers the wrong *public* address, the gateway sends the Coolify bearer token to that host over plain HTTP. Nothing in the protocol can prove the address is the operator's box before the first authenticated call. The mitigations are that the operator is authenticated, the address is validated as public unicast, and the CLI echoes it back for confirmation.
13. **Handoff pricing** is Agent 2's word and the human's. There is no cross-check, and the spend cap does not apply.
14. **`FileLedger` in production.** Registration goes through the gateway process precisely because `FileLedger` caches rows in memory, so a second writer to `ledger.jsonl` would be invisible. Any future second writer reintroduces that (see the ledger's "swap for Redis/Postgres" note).
15. **Agent 2's output** is untrusted scraped text. This repo sanitises it (charset, length, fenced and capped on the card), but Agent 2's own defences are outside it.

## 14. Remaining work

1. **Agent wrapper:** A2A server (`run.start`, `run.poll`, `run.cutover`), a durable run store, Dockerfile. `run.poll` should perform one `advance()` so each call gets a fresh delegation token.
2. ~~Operator commands~~ **built** (keygen, mandate, auditor-token, preflight, live, vault), tested against fakes only.
3. **DronaHQ:** read-only `GET /runs` for the state dashboard; approval screen for cutover; a web form for handoff registration (today it is an operator CLI).
4. **Handoff:** expose `run.candidates` (routing) through the A2A wrapper once it exists; add a second automated vendor to `AUTOMATED_VENDORS` (needs its own adapter and pinned prices).
5. ~~Docs/config~~ **done** (`.env.example`, npm scripts).
6. **Live spikes, in order:** one manual Hetzner `POST /servers`; the Coolify token bootstrap on a real box; a dummy Nasiko connector with one `ask` tool to observe `-32001`; one real Anakin scrape; one real cloud-init boot on a non-Hetzner vendor.

## 15. Phase A findings (from building the operator commands)

- Runbook + persistent ledger: after an interrupted or lost-response purchase the agent-side INTENT blocks a retry (`IN_FLIGHT`). `live --resume` releases it; the gateway ledger stays authoritative. Verified by mutation test.
- Runbook treats a transport timeout during P2 as a definitive failure (settles FAILED). The gateway still prevents a double purchase, but the message is misleading. Not changed.
- Preflight reports existing orphans as WARN, not FAIL (per the plan's table; the plan's test list said FAIL).
- Preflight compares Hetzner's listed EUR price x 1.10 with the pinned USD table and warns when the pinned price is lower (helps step B0).
- Not verified: Hetzner list-endpoint shapes and Cloudflare shapes (fakes follow my memory of the docs); whether Coolify accepts `owner/name` or needs a URL; a Hetzner token's write permission (cannot be checked without buying).

