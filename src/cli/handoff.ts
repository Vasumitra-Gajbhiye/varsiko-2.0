import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { isPublicIPv4 } from '../gateway/ip.ts';
import { isHandoff, verifyMandate, type HandoffProvision, type Mandate } from '../pilot/mandate.ts';
import { runMain, UsageError, type CliIo } from './io.ts';

export const DEFAULT_HANDOFF_DIR = '.local/handoff';
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8787/mcp';

const USAGE = `Usage:
  npm run handoff -- card     --mandate <file> [--out-dir ${DEFAULT_HANDOFF_DIR}]
  npm run handoff -- register --mandate <file> --run-id <id> --ip <ipv4> --port-8000-restricted [--yes]

Operator commands for a mandate a HUMAN fulfils. They use GATEWAY_OPERATOR_TOKEN, not the
bearer Pilot's connector holds, so Pilot can neither render the cloud-init nor register a
server.

  card        Writes the task card and the cloud-init the human pastes into the vendor's
              user-data field. Prints PATHS ONLY: the cloud-init contains the Coolify root
              password, so it must not reach a terminal log, an agent, or a chat.
  register    Records the IP of the server the human bought. The gateway sends its Coolify
              bearer token and every migrated env var to this address, so it is echoed back
              for confirmation and validated as a public IPv4.

  --port-8000-restricted  Attest that the vendor's firewall allows tcp/8000 only from the
                          gateway. Required unless the gateway sets ALLOW_INSECURE_COOLIFY_HTTP.

Exit codes: 0 done, 1 refused by the gateway, 2 usage or declined.`;

/**
 * Prints an untrusted string (vendor, plan, region: Agent 2 scraped them) safely.
 *
 * verifyMandate already restricts the charset, so this is the second layer: a value that
 * somehow carried a newline or a backtick would break out of the card's fenced blocks and
 * could read as an instruction to the human. Refuse to render rather than sanitise quietly.
 */
function fenced(label: string, value: string): string {
  if (value.length > 60 || /[\n\r`$\\<>]/.test(value)) {
    throw new UsageError(`the mandate's ${label} contains characters that cannot be shown safely; do not fulfil this mandate`);
  }
  return value;
}

interface CardInput {
  mandate: Mandate;
  provision: HandoffProvision;
  cloudInitPath: string;
  registerCommand: string;
  gatewayEgressIp: string | null;
}

/** Deterministic: rendered from the SIGNED mandate by code, never by a model. */
export function renderCard(x: CardInput): string {
  const p = x.provision;
  const v = (k: keyof HandoffProvision) => fenced(String(k), String(p[k]));
  return `# Buy one server for mandate ${x.mandate.mandate_id}

Everything below comes from the mandate ${x.mandate.approved_by} signed. Buy EXACTLY this.
If the vendor cannot offer it, stop and ask for a new mandate — do not substitute.

| What | Value |
|---|---|
| Vendor | \`${v('vendor')}\` |
| Plan | \`${v('plan')}\` |
| Region | \`${v('region')}\` |
| Image | \`${v('image')}\` |
| Expected price | \`$${p.expected_monthly_usd}/mo\` |

**The price is UNVERIFIED.** It is what the broker saw at ${fenced('source_url', p.source_url)}.
Nobody has checked it since, and nothing in this system can enforce it: you are paying.
If the vendor's checkout shows a materially different price, stop.

## 1. Buy the server

Choose the plan, region and image above. Then, before the box boots:

## 2. Paste the cloud-init

Paste the ENTIRE contents of \`${x.cloudInitPath}\` into the vendor's **user data** /
**cloud-init** field. Do not edit a single line: the mandate pins this file's SHA-256, and
Coolify will only accept the API token that this exact file installs. An edited or missing
cloud-init produces a box that never becomes healthy, and the run fails.

That file contains a password. Do not paste it into chat, a ticket, or an AI assistant.

## 3. Restrict the firewall

At the vendor, allow inbound **tcp/8000 only from ${x.gatewayEgressIp ?? '<the gateway’s egress IP>'}**.
Coolify's API speaks plain HTTP on that port and carries the migrated environment variables.
Leaving it open to the internet exposes them.

## 4. Register the address

${x.registerCommand}

The command echoes the address back before it does anything. Check it: the gateway sends
its Coolify token and every migrated env var to whatever you register.

## If you abandon the purchase

Do nothing. The mandate expires at ${x.mandate.exp} and the run fails with EXPIRED. Nothing
was bought on Varsiko's side and there is nothing to clean up. If you already bought the
server, cancel it at the vendor yourself.
`;
}

interface HandoffDeps {
  fetch?: typeof fetch;
  now?: () => Date;
}

async function callOperatorTool(
  io: CliIo,
  deps: HandoffDeps,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const token = io.env.GATEWAY_OPERATOR_TOKEN;
  if (!token) throw new UsageError('GATEWAY_OPERATOR_TOKEN is not set (it must match the gateway\'s .env; it is NOT the bearer Pilot uses)');
  const url = io.env.GATEWAY_URL ?? DEFAULT_GATEWAY_URL;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new UsageError(`cannot reach the gateway at ${url}: start it with npm run gateway`);
  }
  if (res.status === 401) throw new UsageError('the gateway rejected GATEWAY_OPERATOR_TOKEN (401)');
  const body = (await res.json().catch(() => ({}))) as {
    result?: { isError?: boolean; content?: { text?: string }[] };
    error?: { message?: string };
  };
  if (body.error) throw new UsageError(`the gateway refused the call: ${body.error.message ?? 'unknown error'}`);
  const text = body.result?.content?.[0]?.text ?? '{}';
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (body.result?.isError) {
    const err = new Error(`${String(parsed.error)}: ${String(parsed.message ?? '')}`);
    (err as { refused?: boolean }).refused = true;
    throw err;
  }
  return parsed;
}

async function loadMandate(io: CliIo, path: string, deps: HandoffDeps) {
  const { readFile } = await import('node:fs/promises');
  const file = JSON.parse(
    await readFile(path, 'utf8').catch(() => {
      throw new UsageError(`cannot read ${path}`);
    }),
  ) as { mandate?: Mandate; token?: string };
  if (!file.mandate || !file.token) throw new UsageError(`${path} is not a { mandate, token } file (see npm run mandate)`);

  const pub = io.env.MANDATE_PUBLIC_KEY_FILE;
  if (!pub) throw new UsageError('MANDATE_PUBLIC_KEY_FILE is not set');
  const publicKey = await readFile(pub, 'utf8').catch(() => {
    throw new UsageError(`cannot read ${pub}`);
  });
  const checked = verifyMandate(file.token, { publicKey, allowExpired: true, now: deps.now?.() });
  if (!checked.ok) throw new UsageError(`the mandate does not verify against MANDATE_PUBLIC_KEY_FILE: ${checked.code}`);
  if (!isHandoff(checked.mandate)) throw new UsageError(`${path} is a ${checked.mandate.provision.provider} mandate; these commands are for --handoff mandates`);
  return { mandate: checked.mandate, provision: checked.mandate.provision, token: file.token };
}

export async function handoffCommand(argv: string[], io: CliIo, deps: HandoffDeps = {}): Promise<number> {
  const sub = argv[0];
  const { values: v } = parseArgs({
    args: argv.slice(sub && !sub.startsWith('-') ? 1 : 0),
    options: {
      mandate: { type: 'string' },
      'run-id': { type: 'string' },
      ip: { type: 'string' },
      'port-8000-restricted': { type: 'boolean', default: false },
      'out-dir': { type: 'string', default: DEFAULT_HANDOFF_DIR },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (v.help || !sub || sub.startsWith('-')) {
    io.out(USAGE);
    return v.help ? 0 : 2;
  }
  if (sub !== 'card' && sub !== 'register') throw new UsageError(`unknown command "${sub}" (expected card or register)`);
  if (!v.mandate) throw new UsageError('--mandate <file> is required (see --help)');

  const { mandate, provision, token } = await loadMandate(io, v.mandate, deps);
  const refused = (e: unknown): number | never => {
    if (!(e as { refused?: boolean }).refused) throw e;
    io.err(`The gateway refused this: ${(e as Error).message}`);
    return 1;
  };

  if (sub === 'card') {
    const outDir = v['out-dir']!;
    const cloudInitPath = join(outDir, `${mandate.mandate_id}.cloud-init.yaml`);
    const cardPath = join(outDir, `${mandate.mandate_id}.card.md`);
    const runId = v['run-id'] ?? `run_${(deps.now ?? (() => new Date()))().getTime()}`;
    const registerCommand = [
      '```',
      `npm run handoff -- register --mandate ${v.mandate} --run-id ${runId} \\`,
      `  --ip <the server's public IPv4> --port-8000-restricted`,
      '```',
    ].join('\n');

    let result: Record<string, unknown>;
    try {
      result = await callOperatorTool(io, deps, 'handoff_prepare', { mandate: token });
    } catch (e) {
      return refused(e);
    }
    const card = renderCard({
      mandate,
      provision,
      cloudInitPath: cloudInitPath.replace(/\\/g, '/'),
      registerCommand,
      gatewayEgressIp: (result.gateway_egress_ip as string | null) ?? null,
    });

    await mkdir(outDir, { recursive: true });
    // 0600: the cloud-init carries the Coolify root password in plaintext.
    await writeFile(cloudInitPath, String(result.cloud_init), { mode: 0o600 });
    await writeFile(cardPath, card, { mode: 0o600 });
    // Paths only. Never the contents.
    io.out(`Task card    ${cardPath.replace(/\\/g, '/')}`);
    io.out(`cloud-init   ${cloudInitPath.replace(/\\/g, '/')}  (contains a password: do not print, paste into chat, or commit)`);
    io.out(`Give the human the card. Register with --run-id ${runId} when the server is up.`);
    return 0;
  }

  // register
  if (!v['run-id']) throw new UsageError('register needs --run-id (use the one the card names)');
  if (!v.ip) throw new UsageError('register needs --ip <the server\'s public IPv4>');
  if (!isPublicIPv4(v.ip)) {
    throw new UsageError(`--ip must be a public IPv4 address. "${v.ip}" is not one (no hostnames, IPv6, ports, or private/loopback/link-local ranges)`);
  }
  if (!v['port-8000-restricted'] && !v.yes) {
    throw new UsageError('pass --port-8000-restricted to attest that the vendor allows tcp/8000 only from the gateway; Coolify\'s API is plain HTTP and carries the env vars');
  }

  io.out(`About to register ${v.ip} as the server bought at ${fenced('vendor', provision.vendor)} for mandate ${mandate.mandate_id}.`);
  io.out(`  The gateway will send its Coolify token and every migrated env var to this address.`);
  io.out(`  tcp/8000 restricted to the gateway: ${v['port-8000-restricted'] ? 'attested' : 'NOT attested'}`);
  if (!v.yes && !(await io.confirm('Is that address correct?'))) {
    io.out('Not confirmed; nothing was registered.');
    return 2;
  }

  try {
    const r = await callOperatorTool(io, deps, 'handoff_register', {
      mandate: token,
      run_id: v['run-id'],
      ip: v.ip,
      port_8000_restricted: v['port-8000-restricted'],
    });
    io.out(`Registered ${String(r.ip)} as ${String(r.server_id)}${r.idempotent ? ' (already registered; unchanged)' : ''}.`);
    io.out(`Continue the run:  npm run live -- --mandate ${v.mandate} --run-id ${v['run-id']} --resume`);
    return 0;
  } catch (e) {
    return refused(e);
  }
}

if (import.meta.main) await runMain((argv, io) => handoffCommand(argv, io));
