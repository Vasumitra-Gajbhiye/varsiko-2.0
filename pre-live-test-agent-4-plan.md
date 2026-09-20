# Agent 4 (Pilot): pre-live-test plan

Handoff for a **fresh session**. Read [agent-4-plan.md](agent-4-plan.md) first for what Pilot is and why it is built this way. This file says what to build **before** any real API key is used, and how to run the live tests afterwards.

## Paste this into the new chat

> Read `pre-live-test-agent-4-plan.md` and `agent-4-plan.md` in full. Execute **Phase A** of the pre-live plan task by task, in order. After each task run `npm run typecheck && npm test` and show me the result. Do not use any real credential, do not print any secret, and do not commit unless I ask. Stop at the end of Phase A and tell me what to do next.

## 0. Ground truth (as of this handoff)

| Fact | Value |
|---|---|
| Local checks | `npm test` = **138 pass**; `npm run pilot` = **15/15** scenarios; `npm run typecheck` clean |
| Real provider calls made so far | **None.** All tests use fakes written in this repo |
| Committed | Nothing. `git status` shows everything as untracked/modified |
| Runtime | Node 24 runs `.ts` directly (`node src/x.ts`), no build step |
| Not started | The gateway server (`src/gateway/main.ts` compiles but has **never been launched**) |

**Do not assume the live services behave like the fakes.** `test/helpers/fake-internet.ts` and `test/helpers/harness.ts` are my own code. They prove the wiring, not the providers.

### Working agreement for the executing session

1. **Write files with the file tool.** In this environment (Git Bash on Windows) shell heredocs containing quotes or nested heredocs failed repeatedly ("unexpected EOF"). For multi-line edits, write a `.py` script file with the file tool and run it, or use the edit tool.
2. `tsconfig.json` has `erasableSyntaxOnly` and `verbatimModuleSyntax`: **no enums, no parameter properties**, use `import type`, and **import paths end in `.ts`**.
3. `npm test` runs `node --test "test/**/*.test.ts"`. Files in `test/helpers/` are not collected.
4. After every task: `npm run typecheck && npm test`. Fix before moving on.
5. **Never print, log or commit a secret.** Tokens live in `.env` (gitignored) or `.local/` (must be added to `.gitignore`, see A0). Output that shows a credential must show `[redacted]`.
6. Say what is unverified. If a provider response shape is from memory, keep the defensive reading and note it.
7. Do not commit unless asked. If asked, end the message with the attribution line the harness gives.

## 1. Interfaces you will reuse (do not re-explore)

```ts
// src/pilot/mandate.ts
interface Mandate { mandate_id; nonce; iat; exp; approved_by; scope: string[];
  budget:{max_monthly_usd; max_hourly_usd};
  provision:{provider:'hetzner'; server_type; image; location; count; cloud_init_sha256};
  migration:{vercel_project_id; git_repository; git_branch; domain};
  surveyor_prediction_sha256; run_window_minutes?: number }
signMandate(m, privateKey: KeyObject|string): string        // "<b64url payload>.<b64url sig>"
verifyMandate(token, {publicKey, now?, allowExpired?})

// src/pilot/auditor.ts
signAuditorToken({mandate_id, server_ip, verdict:'PASS', iat, exp}, key)

// src/pilot/ledger.ts
new FileLedger(path, now?)   new MemoryLedger(now?)         // append-only JSONL

// src/pilot/providers.ts
new NasikoGateway({url, token, fetch?, timeoutMs?})         // JSON-RPC; sends x-nasiko-agent-token
nasikoProviders(gw, {mandate, runId, auditorToken?})        // resolves tool names via tools/list
ToolRefusal (.code, .ambiguous)   McpError (.needsApproval, .blocked)

// src/pilot/runbook.ts
newRun(runId): RunState
advance(state, ctx): Promise<RunState>      // ONE step per call; never loops
run(state, ctx, maxSteps): Promise<RunState> // loops advance(); does NOT sleep
RunContext { mandateToken, publicKey, providers, ledger, now?, auditorPassToken?,
             maxPolls?, maxPricePolls?, requirePriceCheck? }
// RunState.status: RUNNING|WAITING|DEPLOYED|CUTOVER|FAILED|ROLLED_BACK|NEEDS_APPROVAL
// RunState.step:   P0_MANDATE P1_PREFLIGHT P1B_PRICE_SUBMIT P1C_PRICE_POLL P2_PROVISION
//                  P3_BOOT P4_PROJECT P5_ENVS P6_DEPLOY P7_VERIFY P8_CUTOVER DONE

// src/pilot/guard.ts
PINNED_PRICES_USD_MONTH: Record<string, number>   // APPROXIMATIONS, see A0 and B0

// src/gateway/
loadConfig(env), createGatewayServer(deps, {bearerToken, log}), main.ts
Vault(dir, keyHex): put(kind, name, value, ttlMs) / get(kind, name) / delete(name)
//   kind 'coolify' name `coolify:${mandate_id}` -> {api_token, root_password}
//   kind 'env'     name `env:${mandate_id}`     -> [{key,value}]
// ledger file: ${DATA_DIR}/ledger.jsonl   vault dir: ${DATA_DIR}/vault
```

Gateway tools (13): `anakin_scrape_submit|status`, `hetzner_server_create|delete`, `coolify_health|project_create|application_create|envs_bulk_update|application_deploy|deployment_status`, `vercel_env_export`, `cloudflare_dns_upsert|rollback`.

The gateway serves `POST /mcp` with `Authorization: Bearer <GATEWAY_BEARER_TOKEN>` and `GET /healthz`. `NasikoGateway` sends `x-nasiko-agent-token` instead, so a **direct** (no-Nasiko) driver must pass a custom `fetch` that adds the Bearer header. Tool names from the gateway are un-prefixed; `callTool()` handles both.

---

# Phase A: build before any real key (do in order)

Nothing in Phase A may call a real provider. Test with `test/helpers/fake-internet.ts` (add routes there as needed).

## A0. Hygiene and config

- Add to `.gitignore`: `.local/`, `data/`, `*.pem`.
- Rewrite `.env.example` for the **gateway** and the live driver (keep the existing estimator lines). Include every variable in `agent-4-plan.md` §11 plus `GATEWAY_URL` (default `http://127.0.0.1:8787/mcp`) and `GATEWAY_EGRESS_IP`.
- Add npm scripts (`--env-file-if-exists=.env` like the existing `estimate` script): `gateway`, `keygen`, `mandate`, `auditor-token`, `preflight`, `live`, `vault`.
- **Done when:** `git status` shows no `.pem`/`.env` tracked, and `npm run gateway` fails with a clear "missing required env: …" list (already implemented in `loadConfig`).

## A1. Gateway smoke test (it has never been started)

Write `test/gateway-main.test.ts`: spawn `node src/gateway/main.ts` as a child process with **fake** env values (a temp dir with a generated PEM, `VAULT_KEY` of 64 hex, `PORT` chosen free), then assert:

- `GET /healthz` returns 200.
- `POST /mcp` with no/incorrect Bearer returns **401**.
- `tools/list` with the Bearer returns exactly the 13 tools above.
- Startup prints the `note:` lines for each unset optional key.
- The process exits cleanly on kill; nothing secret appears in stdout.

**Done when:** the test passes and `npm run gateway` runs by hand with a fake `.env`.

## A2. `keygen` command: `src/cli/keygen.ts`

`npm run keygen` creates, under `.local/keys/`: `mandate.key.pem`, `mandate.pub.pem`, `auditor.key.pem`, `auditor.pub.pem` (Ed25519, PKCS8 / SPKI PEM; private files mode 0600 where the OS supports it). It also prints a fresh `VAULT_KEY` (64 hex) and `GATEWAY_BEARER_TOKEN` (48+ chars) as **suggestions to paste into `.env`**, never writing them itself.

- **Refuse to overwrite** existing keys unless `--force`.
- Print public-key **paths** for `MANDATE_PUBLIC_KEY_FILE` / `AUDITOR_PUBLIC_KEY_FILE`.
- **Done when:** a test generates keys in a temp dir and `signMandate` → `verifyMandate` round-trips with them; a second run refuses without `--force`.

## A3. `mandate` command: `src/cli/mandate.ts`

Issues a signed mandate for **you as approver**.

```
npm run mandate -- --server-type cpx31 --location nbg1 --image ubuntu-24.04 \
  --repo owner/name --branch main --domain app.example.com --vercel-project prj_xxx \
  --max-monthly 30 --ttl-minutes 10 --run-window 60 --approved-by you@example.com
```

Behaviour:

- `cloud_init_sha256` is **computed** from `cloud-init/coolify.yaml` (`sha256Hex` in `src/gateway/cloudinit.ts`), never typed.
- `mandate_id = mdt_<timestamp>`, `nonce` = 16 random bytes hex, `count` fixed at 1.
- `scope` defaults to the full list used in `src/pilot/demo.ts` `devMandate`; `--no-dns` drops `cloudflare:*`.
- **Refuse** if `server_type` is not in `PINNED_PRICES_USD_MONTH`, or if `--max-monthly` is below the pinned price.
- `surveyor_prediction_sha256`: accept `--prediction-sha256`, else hash the string `"manual-test"` and print a warning.
- **Print a human summary** and require confirmation (`--yes` to skip): *"This authorises buying 1 x cpx31 in nbg1, capped at $30/mo, valid 10 min, deploying owner/name@main"*.
- Writes `.local/mandates/<id>.json` = `{ mandate, token }`. Prints the path, not the token.
- **Done when:** tests cover happy path, unknown server type, budget below price, and that the token verifies with `verifyMandate`.

## A4. `auditor-token` command: `src/cli/auditor-token.ts`

For testing cutover before Agent 5 exists. `npm run auditor-token -- --mandate-file … --server-ip 1.2.3.4 --ttl-minutes 60` → signs `{mandate_id, server_ip, verdict:'PASS', iat, exp}` with `auditor.key.pem`, writes `.local/auditor/<id>.token`. **Done when:** `verifyAuditorToken` accepts it and rejects a different IP.

## A5. `preflight` command: `src/cli/preflight.ts` (read-only)

Checks every configured credential **without spending or reading secret values**. Prints a table of PASS / WARN / FAIL / SKIP per check and exits non-zero on any FAIL. Never prints a token.

| Check | Call | Notes |
|---|---|---|
| Config loads | `loadConfig` | Lists missing vars |
| Keys | files exist, public key parses; mandate signs and verifies | |
| Template | sha256 of `cloud-init/coolify.yaml`; every placeholder whitelisted | |
| Hetzner token | `GET /v1/ssh_keys` | 401 = bad token. Each name in `HETZNER_SSH_KEYS` must exist |
| Hetzner firewall | `GET /v1/firewalls/{id}` | Warn if no rule for tcp/8000 or if it is open to `0.0.0.0/0` |
| Hetzner server type | `GET /v1/server_types` | FAIL if the mandate's type is missing; WARN if deprecated |
| Hetzner location | `GET /v1/locations` / `datacenters` | Warn if the type is not available in the location |
| **Orphans** | `GET /v1/servers?label_selector=managed_by=varsiko-pilot` | List id, name, mandate label, age. WARN if any exist |
| Cloudflare | `GET /user/tokens/verify`, `GET /zones?name=<apex>` | SKIP if unset. **From memory, unverified** |
| Vercel | `GET /v10/projects/{id}/env` **without** `decrypt` | Count vars, count `sensitive`, list sensitive **names** only |
| Anakin | none by default | `--spend-anakin` submits one real scrape (uses credits). Otherwise SKIP |
| Gateway | `GET {GATEWAY_URL}/healthz`, `tools/list` | 13 tools |
| Egress IP | compare `GATEWAY_EGRESS_IP` with the firewall's allowed source | Warn on mismatch |

Response shapes for Hetzner list endpoints are from memory: read defensively, and add the routes to `fake-internet.ts` so tests can cover PASS/FAIL paths. **Whether a Read-only vs Read&Write Hetzner token can be told apart without a write attempt is unknown**; do not attempt an invalid `POST /servers` in preflight. Print "write permission cannot be verified without buying" as a WARN.

**Done when:** tests run preflight against the fake internet for an all-green run and for each FAIL (bad token, missing SSH key, missing server type, orphan present) and assert no token appears in output.

## A6. `live` driver: `src/cli/live.ts` (the important one)

Runs the **real** runbook against the **real gateway** directly, bypassing Nasiko, so provider problems can be isolated from Nasiko problems.

```
npm run live -- --mandate .local/mandates/mdt_x.json [--run-id run_1] [--poll-seconds 10]
                [--stop-after boot|deploy] [--resume] [--yes]
npm run live -- --cutover --mandate … --auditor-token .local/auditor/mdt_x.token --run-id run_1
npm run live -- --cleanup --mandate … --run-id run_1
```

Implementation notes:

- Build `NasikoGateway({url: GATEWAY_URL, token:'direct', fetch})` where `fetch` wraps the global one and **adds `authorization: Bearer ${GATEWAY_BEARER_TOKEN}`**. Providers: `nasikoProviders(gw, {mandate: token, runId, auditorToken})`.
- `RunContext`: `publicKey` from `MANDATE_PUBLIC_KEY_FILE`, `ledger: new FileLedger('.local/pilot-ledger.jsonl')`, `auditorPassToken` set for cutover.
- **Loop with real sleeps** (`run()` does not sleep): `advance` → save state → print only **new** log lines → if `WAITING` sleep `--poll-seconds`. Stop on a terminal status, on `--stop-after`, or on `NEEDS_APPROVAL`.
- **Persist** `RunState` to `.local/runs/<run_id>.json` after every step; `--resume` continues from it. Never store secrets (state contains none).
- **Before the first step, print a banner and require `yes`** (or `--yes`): server type, location, monthly cap, hourly rate estimate, repo, whether DNS is enabled, and the line **"DIRECT MODE: Nasiko is bypassed, so no Nasiko approval or audit applies"**.
- **Ctrl-C**: print the exact `--resume` and `--cleanup` commands. Do not delete anything automatically.
- `--cleanup`: calls `hetzner_server_delete` (gateway confines it to this mandate's servers), then lists remaining `managed_by=varsiko-pilot` servers.
- `--stop-after boot` stops once step 4 completes so the Coolify bootstrap can be inspected by hand (Phase B, B2).
- Exit codes: 0 DEPLOYED/CUTOVER, 1 FAILED/ROLLED_BACK, 2 usage, 3 NEEDS_APPROVAL.
- **Done when:** a test drives the whole flow against `harness.ts` (gateway + fake internet, no Nasiko) including `--resume` after simulated interruption and `--cleanup`; output contains no secret.

## A7. Vault helper: `src/cli/vault.ts` (contingency for the Coolify token)

If the tinker bootstrap does not work on a real box (Phase B, B2), the fallback is to create a Coolify API token by hand in Coolify's UI and give it to the gateway.

```
npm run vault -- put-coolify-token --mandate-id mdt_x     # reads the token from STDIN, never argv
npm run vault -- show-root-password --mandate-id mdt_x --reveal
```

- `put-coolify-token` merges `{api_token}` into the existing `coolify:<mandate_id>` entry (keeps `root_password`).
- `show-root-password` requires `--reveal`, prints once, and warns it is an operator-only secret.
- Uses `DATA_DIR` and `VAULT_KEY` from env. **Done when:** a test round-trips through `Vault` and confirms nothing is printed without `--reveal`.

## A8. Price table verification helper

`PINNED_PRICES_USD_MONTH` in `src/pilot/guard.ts` holds **my approximations**. Add a comment-level TODO and make the `mandate` command print the pinned price it is checking against, so the operator sees it. Real values are set in B0.

## A9. Docs and status

Update `agent-4-plan.md`: files list, run commands, "Remaining work". Keep the "not verified" section honest.

## Phase A exit checklist (run and paste the output)

```
npm run typecheck
npm test                      # expect more than 138, 0 failing
npm run pilot                 # expect 15/15
npm run keygen                # in a scratch dir or with --force off
npm run preflight             # with a FAKE .env: expect clear FAILs, no crash, no secret in output
git status                    # no .env, no *.pem, no .local tracked
```

---

# Phase B: live testing (needs the user's real keys)

Run these **in order**. Do not skip ahead: each step de-risks the next. **Stop on the first surprise** and report it before changing code.

## Safety rules for every live step

- **One server at a time.** Before starting, `npm run preflight` must show **no orphans**. After finishing, it must show none again.
- Use a **low cap**: `--max-monthly` only slightly above the real price, `--run-window 60`.
- Expect real cost of cents per hour. **Verify the real price in the Hetzner console** and set `PINNED_PRICES_USD_MONTH` accordingly (B0).
- Set a **spend alert** in the Hetzner project if available.
- Tokens: short expiry, throwaway. Revoke all at the end. Never paste them into chat: `.env` only.
- If a run ends `FAILED` with `provision outcome unknown` or `MULTIPLE_SERVERS`, **stop and check the Hetzner console by hand** before retrying.

## One-time setup the user does

1. **Hetzner:** new project, API token (Read & Write), upload an SSH key (note its name), create a **Firewall**: inbound tcp/8000 and tcp/22 from **your public IP /32**, tcp/80 and tcp/443 from anywhere. Note the firewall id.
2. **Find your public IP** and set `GATEWAY_EGRESS_IP` to it (Coolify will only answer that IP). If your home IP changes, update both the firewall and the env.
3. **Vercel:** a throwaway project deployed from a small public Next.js repo you control. Give it **2 plain env vars for Production and 1 `Sensitive` one**, so the "could not move" path is exercised.
4. **Fixture repo:** any small public Next.js app that builds with nixpacks and listens on port 3000 (`APP_PORT`).
5. Cloudflare and a domain: **optional**, only for B6.
6. Put everything in `.env` (from `.env.example`). Run `npm run keygen` and copy its suggestions.

## B0. Preflight and prices

`npm run preflight`. Every FAIL must be fixed before continuing. Then compare the mandate's server type against the **actual price in the Hetzner console** and update `PINNED_PRICES_USD_MONTH` (note: Hetzner may price in EUR; the code compares USD, and the scrape check uses an approximate FX of 1.10). **Pass:** all green or explained WARNs.

## B1. Start the gateway alone

`npm run gateway`, then `curl http://127.0.0.1:8787/healthz` and a `tools/list` call with the Bearer. **Pass:** 13 tools, notes printed for anything unset.

## B2. **The Coolify token spike (highest risk; time-box it)**

The whole live path depends on `cloud-init/coolify.yaml` creating a Coolify API token unattended. That block follows a **community workaround** (coollabsio/coolify discussion #11237), not an official interface.

1. `npm run mandate -- …` then `npm run live -- --mandate … --stop-after boot`.
2. Watch for `P3_BOOT … coolify healthy`. The Coolify installer takes several minutes; expect many `booting, poll n/20` lines. **Pass:** healthy, meaning the authenticated `GET /teams/current` answered, so our token exists.
3. If it times out or fails, SSH in (`ssh root@<ip>` with your key) and read `/var/log/varsiko-bootstrap.log`. Check in order:
   - Did `install.sh` finish? Is the `coolify` container running?
   - Does `docker exec coolify php artisan tinker --execute='echo "ready";'` work?
   - Do `App\Models\InstanceSettings::find(0)` and `App\Models\User::find(0)` return rows on this Coolify version?
   - Did `forceFill(['token' => …])` apply? Check the `personal_access_tokens` table.
   - Does Coolify accept a token **without** the `id|` prefix? (Sanctum normally does, but Coolify may customise it.)
   - Is `allowed_ips` blocking the gateway's IP?
4. **Fallbacks, in order:**
   1. Adjust the tinker block, **update the template**, and note that this changes its SHA-256 (mandates pin it, so issue a new mandate).
   2. Manual token: log into Coolify at `http://<ip>:8000` (root password via `npm run vault -- show-root-password … --reveal`), create an API token, then `npm run vault -- put-coolify-token --mandate-id …` (token on stdin). Then re-run from the health step. This is acceptable for the hackathon, but say so in the demo.
   3. Have the gateway create the token over SSH (new design work; discuss with the user first).
5. Afterwards: `npm run live -- --cleanup …` and confirm no orphans.

**Pass:** the token is created unattended, or a fallback is chosen and documented. Record the result in `agent-4-plan.md` §13.

## B3. Full migration without DNS

`npm run live -- --mandate …` (mandate with `--no-dns`). **Pass criteria:**

- Reaches `DEPLOYED`, `next_owner=Auditor`, `dns_writes=0`.
- The app answers on `http://<server-ip>:<port>` or the Coolify-assigned URL. (Verify by hand.)
- Log shows `moved N env vars` and `WARN 1 var(s) NOT moved … <sensitive name>`.
- **No secret** appears in any output or in `.local/runs/*.json`.
- Coolify shows the moved env vars (check by hand in its UI).

Record real timings (boot, deploy) and adjust `maxPolls` if 20 polls x poll-seconds is too short. Then `--cleanup`; confirm no orphans.

## B4. Real Anakin scrape

Run `npm run preflight -- --spend-anakin` (one job), or submit through the gateway. Save the returned **markdown** to `test/fixtures/hetzner-pricing.md` (strip anything sensitive), add a test to `test/pricing.test.ts` proving `extractMonthlyPrice(md, 'cpx31')` finds the row. If it does not, fix the extraction against the **real** page. **Pass:** verdict `VERIFIED` in a live run, not `UNVERIFIED`.

## B5. Failure drills (each must leave zero orphans)

| Drill | How | Expected |
|---|---|---|
| Deploy fails | Point the mandate at a branch that does not build | `ROLLED_BACK`, server destroyed, `$0 committed` |
| Interrupt mid-boot | Ctrl-C during P3, then `--resume` | Continues; exactly one server |
| Interrupt mid-purchase | Kill the process right after P2 starts, then `--resume` | Reconciled by label; **exactly one** server, never two |
| Replay | Run the same mandate file with a new `--run-id` | `REPLAY`, no second server |
| Expired | Wait past `--ttl-minutes`, run again | `EXPIRED`, nothing bought |
| Orphan check | `npm run preflight` after every drill | No orphans |

## B6. Cutover (optional; needs Cloudflare)

Use a **throwaway subdomain**. `npm run auditor-token -- …` with the real server IP, then `npm run live -- --cutover …`. **Pass:** A record → server IP, TTL 60, and a rollback (`cloudflare_dns_rollback` via the gateway) restores the previous record. Direct mode has **no** Nasiko approval, so B7 covers that gate.

## B7. Nasiko (last)

Only after B2 to B5 pass, so failures have fewer possible causes.

1. Expose the gateway at a URL Nasiko can reach (a tunnel such as cloudflared/ngrok for a local gateway, or deploy it). Keep `GATEWAY_BEARER_TOKEN` secret.
2. `nasiko mcp connector probe <url>/mcp`, then `register` with `--auth-type` bearer (credential stays server-side).
3. **Apply `nasiko/tool-rules.json` BEFORE first deploy** (per-agent permission is default-allow).
4. **Test rule precedence** (undocumented): one listed `allow` tool must work, an unlisted tool must be blocked (`-32000`). If the catch-all `*` blocks everything or blocks nothing, restructure the rules.
5. **Observe `-32001`:** call `cloudflare_dns_upsert` (an `ask` tool) and record who can approve, where, and what the caller receives while waiting. This is undocumented; the runbook already treats `-32001` as `NEEDS_APPROVAL`.
6. Find how an agent receives the delegation token from an inbound request (undocumented), then build Phase C.

---

# Phase C: agent wrapper and DronaHQ (after Phase B)

Not needed for the live tests above. Build once B2 to B5 pass.

## C1. A2A agent: `src/agent/`

Nasiko container contract: unauthenticated `GET /.well-known/agent-card.json` (serve `nasiko/AgentCard.json`), and an A2A JSON-RPC endpoint implementing at least `message/send` returning a Task envelope with status and artifacts; health = HTTP 200.

- Skills (already declared in `AgentCard.json`): `run.start`, `run.poll`, `run.cutover`. Read them from a **data part** `{kind:'data', data:{skill, ...}}` or a JSON text part.
- **`run.poll` performs exactly one `advance()`** then returns the state. Reason: Nasiko mints the delegation token per inbound request and it expires in minutes, so each advance needs a fresh token. `run.start` verifies, saves state, does one advance, returns `run_id`.
- Token source: header `x-nasiko-agent-token` by default (`NASIKO_TOKEN_HEADER` override; **unverified**), fall back to `NASIKO_AGENT_TOKEN` env for local runs. Build `NasikoGateway({url: MCP_GATEWAY_URL, token})` per request.
- `RunStore`: JSON file per run, single-replica assumption (state is local disk); an in-process mutex per `run_id` so two polls cannot advance concurrently. The gateway ledger is still the authority.
- Stores the mandate token with the run (a single-use, expiring capability, not a provider credential).
- `Dockerfile`: `FROM node:24-slim`, `CMD ["node","src/agent/main.ts"]`, expose 8000. **Whether Nasiko's build accepts a Node container is unverified**; Nasiko's templates are Python/Rust/Go.
- Tests: A2A envelope shape, poll-advances-once, concurrent polls, resume after restart.

## C2. DronaHQ

Not integrated. Add **read-only** `GET /runs` and `GET /runs/{id}` to the agent (bearer auth) returning step, status, `cost_committed_usd`, `servers_bought`, `dns_writes`, `next_owner`, `env_skipped`, and the log. A DronaHQ app reads that as a REST data source (**its connector auth options are unverified**) to show a step timeline. Use DronaHQ, not Pilot, as the screen for the cutover approval.

## C3. Optional hardening

`mandate_status` gateway tool (preflight nonce check on the gateway side); envelope encryption of env blobs to the box; pinning Coolify's `install.sh`; Hetzner API price lookup instead of a scrape; OpenTofu-style state so reruns converge.

---

## Known unverified items (carry forward; update as live tests resolve them)

1. Coolify token bootstrap via `tinker` (B2).
2. Cloudflare client shapes, from memory (B6).
3. Nasiko: rule precedence, `-32001` approval UX, delegation-token delivery to an agent (B7).
4. Price extraction against the real page (B4); pinned prices (B0).
5. Coolify `GET /servers` shape and deployment `status` vocabulary; unknown statuses are treated as `running`, never `success`.
6. Hetzner list-endpoint shapes used by preflight; server-type availability per location.
7. Vercel: `sensitive` vars are write-only; pagination beyond page one is reported as `truncated`, not followed.
8. The fake internet and fake Nasiko in `test/helpers/` are my own code.

## Definition of done for this whole plan

- Phase A merged with typecheck clean and all tests passing (count reported).
- Phase B: B0 to B5 pass with zero orphans at the end; every unverified item above either resolved or explicitly re-listed.
- `agent-4-plan.md` updated with real results, timings, and what changed in code.
- All live tokens revoked.
