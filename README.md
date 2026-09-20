<div align="center">

<img src="docs/assets/banner.svg" alt="Varsiko — leave Vercel, on a human's signature" width="100%">

<br>

**Four A2A agents take a GitHub URL and a rupee ceiling, and move a Vercel-coupled Next.js app onto a server you own.**
**No agent holds a provider credential. Every rupee is authorised by a signature a human made offline.**

<br>

![Agents](https://img.shields.io/badge/agents-4-1B6C77?style=for-the-badge)
![Protocol](https://img.shields.io/badge/protocol-A2A%20%2B%20MCP-1B6C77?style=for-the-badge)
![Signature](https://img.shields.io/badge/spend%20auth-Ed25519-A85B13?style=for-the-badge)
![Offline](https://img.shields.io/badge/default-OFFLINE%3D1-2C6349?style=for-the-badge)
![Docs](https://img.shields.io/badge/architecture-19%20sections-465563?style=for-the-badge)

[Quick start](#-quick-start) ·
[How it works](#-how-it-works) ·
[The agents](#-the-four-agents) ·
[Security model](#-the-security-model) ·
[Repo map](#-repository-map) ·
[Full architecture](ARCHITECTURE.md)

</div>

<br>

| `0` | `120 s` | `3×` | `14 / 2` | `9` | `2` |
|:---:|:---:|:---:|:---:|:---:|:---:|
| credentials on the Pilot | flow-guard kill | MAF step retry | agent / operator tools | runbook steps | human gates |

---

## 🧭 Why this exists

Vercel is easy to enter and expensive to leave. Not because of the bill, but because a naive `next start` in Docker **appears to work**. Blob and KV break loudly. Crons, ISR and geolocation go quiet.

| Coupling | Off-platform, if you do nothing | Class |
|---|---|---|
| `@vercel/blob` | No token is issued. Every upload, delete and list fails. | 🔴 Runtime break |
| `@vercel/kv` | The Upstash REST connection does not exist. | 🔴 Runtime break |
| `vercel.json` crons | Routes still answer. Nothing calls them. The digest just stops arriving. | 🟠 **Silent drift** |
| ISR / `revalidate` | Each replica keeps its own `.next/cache`; `revalidatePath` clears one container. | 🟠 **Silent drift** |
| `@vercel/functions` | `geolocation()` returns `undefined` instead of throwing. Geo rules quietly stop applying. | 🟠 **Silent drift** |
| No Dockerfile | Nothing in the repo says how to build or run it anywhere else. | 🟡 Build break |

> [!IMPORTANT]
> **The failure mode that ruins a migration is not the build that breaks. It is the thing that keeps working and quietly stops being correct.**
> Everything below (the falsifiable capacity spec, the honest rewrite report, the signed mandate) exists to make silent drift impossible to ship.

---

## ⚙️ How it works

```mermaid
flowchart LR
    IN(["GitHub URL<br/>+ rupee ceiling"]) --> S
    S["<b>01 Surveyor</b><br/>reads Vercel + repo<br/>emits capacity spec"] --> P
    P["<b>03 Porter</b><br/>rewrites a copy<br/>emits diff + plan"] --> B
    B["<b>02 Broker</b><br/>shops VPS vendors<br/>mints cart mandate"] --> PI
    PI["<b>04 Pilot</b><br/>redeems a signed<br/>spend mandate"] --> OUT(["App live on<br/>a server you own"])

    classDef read fill:#E3F1F3,stroke:#1B6C77,color:#0E1620,stroke-width:1.5px
    classDef spend fill:#FBEBD8,stroke:#A85B13,color:#0E1620,stroke-width:2px
    classDef io fill:#EEF1F4,stroke:#8F9EAC,color:#0E1620
    class S,P,B read
    class PI spend
    class IN,OUT io
```

There is **one** MAF workflow, `severance-pipeline`. In the MAF hop the Porter dry-runs and the Pilot **parks** on a cart mandate; it never completes a purchase inside a 120-second call. The actual spend happens afterwards, one polled step at a time.

### Assessment → parked cart

```mermaid
sequenceDiagram
    autonumber
    actor U as App owner
    participant N as Nasiko
    participant S as Surveyor
    participant P as Porter
    participant B as Broker
    participant PI as Pilot

    U->>N: repo URL + ceiling_inr_monthly
    N->>S: A2A message/send
    Note over S: read Vercel billing, metrics, env<br/>fetch tarball, static walk<br/>never infers a ceiling
    S-->>N: capacity_spec/v1 + predictions{sha256}
    N->>P: spec
    Note over P: scan, plan, rewrite on a copy
    P-->>N: port_plan/v1 + diff + "Needs a human"
    N->>B: spec
    Note over B: shop Hetzner, DO, Vultr<br/>score in Python, pinned FX
    B->>B: mint_mandate() refuses above ceiling
    B-->>N: shop_result/v1 + cart_mandate/v1 (HMAC)
    N->>PI: cart mandate
    PI->>PI: verify HMAC AND re-check monthly_inr ≤ ceiling
    PI-->>U: PARKED — awaiting an Ed25519 spend mandate
```

### The spend run (outside the MAF hop)

```mermaid
sequenceDiagram
    autonumber
    actor OP as Operator
    participant PI as Pilot agent
    participant G as Mandate gateway
    participant H as Hetzner
    participant C as Coolify
    actor AU as Auditor

    OP->>OP: npm run mandate (Ed25519, offline key)
    OP->>PI: run.start(mandate)
    PI-->>OP: run_id, returned immediately
    loop one step per poll
        OP->>PI: run.poll(run_id)
        PI->>G: tools/call (via Nasiko stance gate)
        G->>G: verify sig, exp, scope · pin args · cap spend
        G->>G: ledger INTENT — before the spend
        G->>H: POST /servers (labelled mandate_id)
        G->>G: ledger COMMITTED
        G->>C: health, project, envs, deploy
        PI-->>OP: step, state, committed cost
    end
    AU->>OP: Ed25519 PASS token bound to mandate + IP
    OP->>PI: run.cutover(token)
    PI->>G: cloudflare_dns_upsert (Nasiko ask → human approves)
    G->>G: verify PASS token independently, TTL 60
```

---

## 🚀 Quick start

> [!NOTE]
> Everything below runs **offline by default** (`*_OFFLINE=1`). The demo path is *incapable* of spending money, not merely configured not to.

### 1. Try each agent locally, no infrastructure

```sh
# Surveyor / Broker (Python 3.12)
cd agents/severance/surveyor && PYTHONPATH=src python -m pytest
cd agents/severance/broker   && PYTHONPATH=src python -m pytest

# Porter (Node 20): plans the bundled fixture, writes nothing
cd agents/severance/porter   && npm install && npm test && npm run demo

# Pilot (Node 24): runbook + gateway, 19 offline scenarios
cd agents/severance/pilot    && npm install && npm test && npm run pilot
```

### 2. Run the full pipeline on Nasiko

Requires a Nasiko control plane at `http://localhost:8080` with `AGENT_RUNTIME=docker`.

```sh
./agents/severance/deploy-nasiko.sh     # build agents, apply tool rules, upsert severance-pipeline
python3 ui/serve.py                     # demo UI, stdlib only
```

Open **<http://127.0.0.1:8788>**, paste a GitHub URL. The UI calls Nasiko A2A (`/api/orchestrator/a2a`), so traces show up under **Sessions**. It injects a default ceiling of ₹1500; the Surveyor never infers one.

### 3. Drive a signed spend run (operator path)

```sh
cd agents/severance/pilot
cp .env.example .env                    # fill in real values, never commit
npm run keygen                          # Ed25519 mandate + auditor keypairs, vault key
npm run gateway                         # mandate gateway on :8787

npm run mandate -- --server-type cpx31 --location nbg1 \
  --repo owner/name --vercel-project prj_x \
  --domain app.example.com --max-monthly 30 --approved-by you@example.com
```

<details>
<summary><b>Operator commands</b></summary>

| Command | What it does |
|---|---|
| `npm run keygen` | Generates the Ed25519 keypairs and a vault key |
| `npm run gateway` | Starts the MCP mandate gateway (`:8787`) |
| `npm run mandate` | Signs a spend mandate with the offline private key, printing the price it checks |
| `npm run auditor-token` | Issues the Auditor's PASS token bound to mandate + IP |
| `npm run preflight` | Checks config before a live run |
| `npm run live` | Live driver, direct to the gateway (bypasses Nasiko) |
| `npm run handoff` | Handoff lane: a human buys the server at another vendor |
| `npm run vault` | Sealed-vault utilities |

</details>

---

## 🤖 The four agents

| # | Agent | Runtime | Trusted to | Cannot | Emits |
|:-:|---|---|---|---|---|
| 01 | [**Surveyor**](agents/severance/surveyor) | Python 3.12 | read the live Vercel project and repo; commit a hashed, falsifiable prediction | spend, deploy, run the repo, or infer a ceiling | `capacity_spec/v1` |
| 03 | [**Porter**](agents/severance/porter) | Node 20 / TS | rewrite Vercel couplings on a **copy**; say what it could not fix | write to your repo, or drop a finding | `port_plan/v1` + diff |
| 02 | [**Broker**](agents/severance/broker) | Python 3.12 | shop Hetzner / DigitalOcean / Vultr; score in code; mint an HMAC cart mandate | redeem the mandate it mints | `shop_result/v1` + `cart_mandate/v1` |
| 04 | [**Pilot**](agents/severance/pilot) | Node 24 | drive a resumable runbook under a signed mandate | hold **any** provider credential | `pilot_run/v1` |

The Pilot package is deliberately **two processes**: the *agent* an LLM drives, and the *mandate gateway* that holds every key. The boundary is a process boundary with its own authentication, not a module boundary an `import` can cross.

---

## 🔐 The security model

### Eight invariants

Every structural decision derives from one of these. Breaking one is an architecture change, not an implementation change.

| | Invariant | In one line |
|:-:|---|---|
| **I1** | The LLM narrates. Code decides. | A model may write a summary. It may never size a server, pick a verdict or authorise a spend. |
| **I2** | Authority is a signed capability, not a role. | Single-use, scoped, expiring, human-signed, re-verified on every call. |
| **I3** | The predictor never validates. | The Surveyor commits a hashed prediction; a separate Auditor with its own key falsifies it. |
| **I4** | One step per call; resumable and idempotent. | A 120 s flow guard plus 3× retry would otherwise turn one slow purchase into three. |
| **I5** | Untrusted text never becomes authority. | Repo files and vendor pricing pages may inform a display, never widen a bound. |
| **I6** | Secrets flow down, never up. | The agent is the principal with nothing to steal. |
| **I7** | Unfixable is reported, never dropped. | A migration that silently omits a finding is worse than one that refuses. |
| **I8** | Offline by default. | Fixture stores everywhere; CI is network-free. |

### Five planes, split by what each is trusted to do

```mermaid
flowchart TB
    subgraph INTENT["INTENT · zero authority"]
        UI["Demo UI :8788"]
        CLI["nasiko chat"]
    end
    subgraph CONTROL["CONTROL · Nasiko :8080 · cannot cap rupees"]
        A2A["A2A router"]
        MAF["MAF workflow<br/>severance-pipeline"]
        SEC["agent secrets<br/>AES-256-GCM"]
        OTEL["trace store"]
    end
    subgraph REASON["REASONING · 4 containers :8000 · propose, never decide"]
        S["01 Surveyor"] --> P["03 Porter"] --> B["02 Broker"] --> PI["04 Pilot<br/><b>0 credentials</b>"]
    end
    GATE{{"Nasiko stance gate<br/>allow · ask ⇒ -32001 · block"}}
    subgraph AUTH["AUTHORITY · gateway :8787 · holds every key"]
        V["verify mandate<br/>sig · exp · scope · EVERY call"]
        G["guard<br/>pin args · enforce cap"]
        L["write-ahead ledger<br/>INTENT → COMMITTED"]
        VA["sealed vault<br/>+ provider keys"]
    end
    subgraph TGT["TARGET · the new server · reaches nothing back"]
        CO["Coolify :8000<br/>firewalled to gateway"]
        APP["app :3000"]
        RED["Redis"]
        S3["S3 store"]
    end

    UI --> A2A
    CLI --> A2A
    A2A --> MAF --> S
    PI ==>|"delegation token + mandate"| GATE ==> V --> G --> L
    G --> VA
    VA ==>|"pinned, scoped actions only"| CO
    OPER["OPERATOR<br/>Ed25519 private key, offline"] -.->|spend mandate| V
    AUDR["AUDITOR<br/>own keypair, falsifies I3"] -.->|PASS token| V
    OPCLI["Operator CLI<br/>GATEWAY_OPERATOR_TOKEN"] -.->|"bypasses Nasiko"| V

    classDef hot fill:#FBEBD8,stroke:#A85B13,color:#0E1620,stroke-width:2px
    class PI,GATE,V,G,L,VA hot
```

> [!TIP]
> **The one edge that matters** is the thick line out of the Pilot. It carries a *delegation token* proving **which agent** is calling and a *mandate* proving **what a human authorised**. The gateway requires both, so compromising the agent yields the first and not the second.

### Two mandates, two cryptosystems

Minting is not redeeming, and verifying is not minting. The split of primitives is what makes those sentences true.

```mermaid
flowchart LR
    subgraph HOLD["KEY HOLDER"]
        BR["02 Broker · an agent<br/>MANDATE_SIGNING_SECRET<br/><i>symmetric</i>"]
        OP["Operator · a human<br/>Ed25519 <b>PRIVATE</b> key<br/><i>never leaves the laptop</i>"]
    end
    subgraph ART["ARTIFACT"]
        CART["cart_mandate/v1<br/>HMAC-SHA256 · TTL 900 s"]
        SPEND["spend mandate<br/>Ed25519 · nonce · exp<br/>scope · pinned args"]
    end
    subgraph VER["VERIFIER"]
        PIL["04 Pilot<br/>verifies HMAC AND<br/>re-checks the ceiling"]
        GW["Mandate gateway<br/>Ed25519 <b>PUBLIC</b> key only<br/><i>can verify, cannot mint</i>"]
    end
    BR --> CART --> PIL
    OP ==> SPEND ==> GW
    BR -. "✗ cannot redeem what it mints" .-> GW

    classDef hot fill:#FBEBD8,stroke:#A85B13,color:#0E1620,stroke-width:2px
    class OP,SPEND,GW hot
```

Symmetric is correct for the cart mandate: both ends are machines Nasiko provisions. Asymmetric is **required** for the spend mandate. If the gateway could mint, a gateway compromise would be a money-printing compromise.

<details>
<summary><b>The capability, as signed</b></summary>

```jsonc
{
  "mandate_id": "mdt_8891", "nonce": "…", "iat": "…", "exp": "…",
  "approved_by": "operator@…",
  "scope":     ["hetzner:server.create", "coolify:*", "cloudflare:dns.upsert", "…"],  // namespace matcher
  "budget":    { "max_monthly_usd": 60, "max_hourly_usd": 0.12 },                     // enforced in code
  "provision": { "provider": "hetzner", "server_type": "cpx31", "location": "nbg1",
                 "count": 1, "cloud_init_sha256": "<sha256 of the template>" },       // every arg pinned
  "migration": { "vercel_project_id": "…", "git_repository": "…", "domain": "…" },
  "surveyor_prediction_sha256": "…",                                                  // binds I3
  "run_window_minutes": 120
}
```

</details>

### Defence in depth: no single mechanism is sufficient

| Threat | Mechanism A | Mechanism B (independent) |
|---|---|---|
| Over-cap purchase | Broker refuses inside `mint_mandate()` | Pilot re-checks the ceiling on a mandate it did not mint |
| Unauthorised DNS cutover | Nasiko `ask` stance returns `-32001`; a human approves | Gateway verifies an Auditor PASS token bound to this mandate **and this IP** |
| Double purchase | Write-ahead `INTENT` row refuses a re-spend | Gateway reconciles by Hetzner label instead of re-buying |
| Poisoned vendor price | `effective = max(pinned, scraped)`: a page can only *raise* the price | Pinned fallback price table in the guard |
| Agent reaching a provider directly | Every other MCP connector set `enabled: false` | The gateway is the only holder of provider credentials |

### If it is fully compromised

| Compromised | The attacker gets | The attacker still cannot |
|---|---|---|
| Any agent container | read-only Vercel/GitHub tokens, a mandate it was already given | spend outside the pinned arguments, cut DNS over, reach a provider directly |
| Broker | ability to mint cart mandates | exceed the ceiling (the Pilot re-checks) or buy anything |
| Nasiko control plane | agent secrets, delegation tokens, the gateway bearer | forge the operator's Ed25519 signature, so no spend mandate |
| Gateway host | every provider credential (**total loss for spend**) | mint a new mandate, or delete servers outside the mandate's label |
| Operator machine | the signing key (**total loss**) | n/a: this is why the key is offline and mandates are single-use, capped and expiring |

---

## 🧾 Why a write-ahead ledger, and not a retry

Nasiko kills any agent-to-agent call at **120 s**. MAF retries a failed step **3×**. A Hetzner provision that succeeds at 95 s but whose response is lost at 120 s comes back as a *failure*. This is the single most expensive bug the architecture had to design out.

```mermaid
sequenceDiagram
    participant M as MAF retry
    participant G as Gateway
    participant H as Hetzner

    rect rgb(250, 232, 230)
    Note over M,H: NAIVE — retry on failure
    M->>G: hetzner_server_create
    G->>H: POST /servers
    H-->>G: server #1 created (95 s)
    Note over G: flow guard kills the call at 120 s, response lost
    M->>G: retry ×3, no memory of #1
    Note over H: 3 servers · 1 approved · 3× the bill
    end

    rect rgb(226, 240, 232)
    Note over M,H: WRITE-AHEAD — intent before spend
    M->>G: hetzner_server_create
    G->>G: ledger INTENT mdt_8891:P2
    G->>H: POST /servers, labelled mdt_8891
    H-->>G: server #1 created (95 s)
    Note over G: kill at 120 s, row stays INTENT
    M->>G: retry arrives
    G->>H: finds open INTENT, list by label
    Note over H: 1 server · reconciled by label · never re-bought
    end
```

Recording intent **before** the provider call converts an ambiguous outcome from "unknown, so retry" into "unknown, so reconcile". The ledger (append-only JSONL today, a Postgres `UNIQUE(key)` when a second gateway replica exists) is the system of record for money, kept separate from traces and the audit log on purpose.

---

## 🛤️ The runbook advances one step per call

Callers poll. Every step re-verifies the mandate instead of trusting state carried between calls, because Nasiko mints the delegation token per inbound request and it expires in minutes.

```mermaid
stateDiagram-v2
    direction LR
    [*] --> P0_MANDATE
    P0_MANDATE --> P1_PREFLIGHT
    P1_PREFLIGHT --> P1B_PRICE: automated + pricing
    P1B_PRICE --> P2_PROVISION
    P1_PREFLIGHT --> P2_PROVISION: automated
    P1_PREFLIGHT --> P2H_AWAIT_PURCHASE: handoff
    P2H_AWAIT_PURCHASE --> P2H_AWAIT_PURCHASE: parked, not failed
    P2H_AWAIT_PURCHASE --> P3_BOOT: handoff_register
    P2_PROVISION --> P3_BOOT: ledger COMMITTED
    P3_BOOT --> P4_PROJECT
    P4_PROJECT --> P5_ENVS
    P5_ENVS --> P6_DEPLOY
    P6_DEPLOY --> P7_VERIFY
    P7_VERIFY --> P8_CUTOVER: domain + Auditor PASS
    P7_VERIFY --> DONE: no domain
    P8_CUTOVER --> NEEDS_APPROVAL: Nasiko -32001
    NEEDS_APPROVAL --> P8_CUTOVER: human approves
    P8_CUTOVER --> DONE
    P3_BOOT --> ROLLED_BACK: post-purchase failure
    DONE --> [*]
```

| Lane | Who buys | Rollback | Cap enforceable? |
|---|---|---|---|
| **Automated** | the gateway, on Hetzner | `hetzner_server_delete`, confined to servers this mandate labelled | ✅ yes |
| **Handoff** | a human, at any other vendor | **no destroy**: never deletes a server a human paid for | ⚠️ no. Card marked **UNVERIFIED** |

Both lanes converge because `handoff_register` writes the **same `P2` ledger row** an automated purchase writes. Target derivation, the run window, replay protection and every downstream tool then work unchanged, which is why this is one runbook and not two.

<details>
<summary><b>Two bearers on one gateway</b></summary>

| Credential | Held by | Reaches | Cannot |
|---|---|---|---|
| `GATEWAY_BEARER_TOKEN` | Nasiko's MCP connector → the Pilot agent | 14 tools | `handoff_prepare`, `handoff_register` |
| `GATEWAY_OPERATOR_TOKEN` | the human operator's CLI, **outside Nasiko** | `handoff_prepare`, `handoff_register` | buy anything |

The role filter applies to both `tools/list` and `tools/call`: the agent cannot even enumerate the operator's tools. `handoff_register` accepts only a **public IPv4 unicast** address, refusing loopback, RFC 1918, link-local (including `169.254.169.254`), CGNAT, multicast, reserved ranges, IPv6, hostnames and ports, because an unvalidated address from an LLM-driven agent would be a direct SSRF-and-exfiltration primitive.

</details>

---

## 📦 What the customer is left running

The output is itself an architecture, and the Porter's transforms define it.

```mermaid
flowchart LR
    subgraph VPS["One VPS · Coolify-managed"]
        CO["Coolify :8000<br/>deploys · firewalled"]
        APP["Next.js standalone :3000<br/>multi-stage · non-root · healthcheck"]
        SCHED["cron runner<br/>porter-schedules.json<br/>UTC · per-minute lock"]
        REDIS["Redis<br/>shared ISR cache · KV shim<br/>cron lock"]
    end
    S3["S3-compatible object store<br/>presigned PUT + signed callback"]
    CO -.->|deploys| APP
    APP --> REDIS
    SCHED --> REDIS
    APP --> S3

    subgraph HUMAN["Still needs a human"]
        H1["@vercel/edge-config: no equivalent"]
        H2["existing blobs are not copied"]
        H3["KV data is not migrated"]
        H4["remotePatterns needs the new CDN host"]
        H5["Vercel sensitive vars cannot be exported"]
    end

    classDef hot fill:#FBEBD8,stroke:#A85B13,color:#0E1620,stroke-width:2px
    classDef warn fill:#FAE8E6,stroke:#9E2B26,color:#0E1620
    class APP hot
    class H1,H2,H3,H4,H5 warn
```

| Vercel coupling | Replacement | Why this shape |
|---|---|---|
| `@vercel/blob` | S3 shim, identical signatures and return shapes | Call sites do not change. Uploads are replaced **as a pair** (presigned PUT *and* signed callback) |
| `@vercel/kv` | Redis shim reproducing Upstash's auto-JSON serialisation | A plain `ioredis` swap stores `[object Object]` without throwing |
| `vercel.json` crons | extracted schedule + zero-dependency runner | The per-minute Redis lock stops every replica firing the same job |
| ISR / `revalidate` | shared Redis cache handler | Per-replica `.next/cache` means users see different versions of a page |
| `@vercel/functions` geo | explicit replacement | `geolocation()` returns `undefined`, the worst kind of silent drift |
| `@vercel/edge-config` | **none exists**, reported under "Needs a human" | Honesty beats a broken shim (**I7**) |
| no Dockerfile | multi-stage `output: 'standalone'`, non-root, compose | Nothing in the repo said how to build it elsewhere |

---

## 🗺️ Repository map

```text
varsiko-2.0/
├── ARCHITECTURE.md              ← the full document: 19 sections, threat model, ADRs, roadmap
├── agents/severance/
│   ├── deploy-nasiko.sh         ← build agents · apply tool rules · upsert severance-pipeline
│   ├── surveyor/                ← 01 · Python 3.12 · read-only · capacity spec + prediction
│   ├── porter/                  ← 03 · Node 20 / TS · rewrites a copy · templates/ for the shims
│   ├── broker/                  ← 02 · Python 3.12 · adversarial shopping · HMAC cart mandate
│   └── pilot/                   ← 04 · Node 24
│       ├── src/pilot/           │   mandate · ledger · guard · runbook · pricing
│       ├── src/gateway/         │   MCP mandate gateway (separate process, holds keys)
│       ├── src/cli/             │   operator commands: keygen, mandate, live, handoff …
│       ├── src/agent/           │   Nasiko A2A server (run.start / poll / cutover / candidates)
│       ├── tool-rules.json      │   per-agent MCP stances, trailing "*": block
│       └── cloud-init/          │   pinned Coolify bootstrap template
├── ui/                          ← demo UI on :8788, Python stdlib only
└── docs/assets/                 ← README artwork
```

Per-agent READMEs carry the full config tables and secret-setup commands: [Surveyor](agents/severance/surveyor/README.md) · [Broker](agents/severance/broker/README.md) · [Porter](agents/severance/porter/README.md) · [Pilot](agents/severance/pilot/README.md).

### Environment

| Variable | Where | Meaning |
|---|---|---|
| `SURVEYOR_OFFLINE` `BROKER_OFFLINE` `PORTER_OFFLINE` `PILOT_OFFLINE` | every agent | `1` uses fixtures, so the path cannot spend. Set in every `Dockerfile` **and** `deploy-nasiko.sh` |
| `MANDATE_SIGNING_SECRET` | Broker + Pilot, **agent-scoped** | HMAC secret for cart mandates. Never vault-wide |
| `FX_USD_INR` `FX_EUR_INR` `FX_PINNED_AT` | Surveyor, Broker | Pinned, never fetched, so signed artifacts stay verifiable |
| `GATEWAY_BEARER_TOKEN` `GATEWAY_OPERATOR_TOKEN` | gateway | ≥ 32 chars each, must differ, enforced at config load |
| `VAULT_KEY` `MANDATE_PUBLIC_KEY_FILE` `AUDITOR_PUBLIC_KEY_FILE` | gateway | Sealed-vault key and the two verification keys (public only) |
| `HETZNER_TOKEN` `CLOUDFLARE_TOKEN` `VERCEL_TOKEN` `ANAKIN_API_KEY` | gateway | Provider credentials. **No agent holds these** |

> [!WARNING]
> The Ed25519 mandate **private** key lives on the operator's machine (`.local/keys/`, gitignored). It is never in CI, never in Nasiko, never on the gateway. That is not a policy; it is the reason the architecture works.

---

## 🧪 Honest status

An architecture that hides its weak edge is a liability. Every claim in [ARCHITECTURE.md](ARCHITECTURE.md) is tagged `[BUILT]`, `[TARGET]` or `[UNVERIFIED]`.

| ID | Risk | Held in check by | Closed when |
|---|---|---|---|
| **RISK-01** | Coolify's API is plain HTTP on `:8000`, and the gateway sends it a token and every migrated env var | Provisioning refused without a Hetzner firewall; only the token's hash reaches `user_data` | TLS terminates before the first env push |
| **RISK-02** | Nasiko per-agent permission is **default-allow** | Explicit rules plus a trailing `{"pattern":"*","stance":"block"}` | The deploy fails closed on a stance read-back mismatch |
| **RISK-03** | The cloud-init bootstrap follows a community workaround touching Coolify internals | Pinned by SHA-256 inside the signed mandate | Verified on one real box; installer version pinned |
| **RISK-05** | The pinned price table is approximate; Hetzner prices in EUR, the cap is USD | `npm run mandate` prints the value it checks before signing | Re-pinned from the console; currency explicit in `budget` |
| **RISK-08** | The handoff lane cannot enforce a cap or observe checkout | Card marked UNVERIFIED; no-destroy; charset clamps | Accepted by design: documented, not pretended away |

### The pipeline still owed

There is no CI in the repo today, so this is design, not description. CI never holds a spend credential, and the unit of release is the agent, not the repo.

```mermaid
flowchart LR
    G1["G1<br/>lint + typecheck"] --> G2["G2<br/>offline unit tests"] --> G3["<b>G3</b><br/>contract tests<br/>4 schema edges"] --> G4["<b>G4</b><br/>security gates<br/>+ invariant lint"] --> G5["<b>G5</b><br/>build · SBOM<br/>Trivy · cosign"] --> G6["G6<br/>e2e on ephemeral<br/>Nasiko"]
    classDef block fill:#FAE8E6,stroke:#9E2B26,color:#0E1620,stroke-width:2px
    classDef warn fill:#EEF1F4,stroke:#8F9EAC,color:#0E1620
    class G3,G4,G5 block
    class G1,G2,G6 warn
```

Red gates block merge. **G4 carries an invariant lint** (a pure module that imports `httpx`, `openai` or `fetch` fails the build) because I1 is what makes every number falsifiable, and it decays silently.

### Two SLOs that are not statistical

**Zero orphaned paid servers, and zero spends above a signed mandate's cap.** No error budget. A single violation is an incident, not a draw against a quota.

### Roadmap

- [ ] **Now:** CI gates G1–G4 · contract tests on all four schema edges · deploy hardening (git-SHA versioning, hard-gated tool rules, rollback)
- [ ] **Next:** resolve RISK-01 / RISK-03 on one real box · containerise the gateway · ship audit lines to the trace collector
- [ ] **Later:** Postgres ledger + N gateway replicas · Auditor as a first-class agent · post-cutover Day-2 checklist · DronaHQ operator console

---

## 📚 Further reading

| Document | What is in it |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The whole solution: invariants, planes, contracts, authority, threat model T1–T13, secrets, observability, DevOps, SLOs, ADRs |
| [agent-1-plan.md](agent-1-plan.md) · [agent-2-plan.md](agent-2-plan.md) · [agent-4-plan.md](agent-4-plan.md) | Per-agent design plans |
| [pre-live-test-agent-4-plan.md](pre-live-test-agent-4-plan.md) | Failure drills to run before the first live spend |
| [repo-change-for-buying-server-plan.md](repo-change-for-buying-server-plan.md) | Repo changes for the automated lane and the human handoff lane |

<div align="center">
<sub>Varsiko / Severance · Surveyor · Broker · Porter · Pilot</sub>
</div>
