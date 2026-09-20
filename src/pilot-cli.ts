import { parseArgs } from 'node:util';
import { devKeys, SCENARIOS } from './pilot/demo.ts';
import type { FakeProviders } from './pilot/providers.ts';
import type { RunState } from './pilot/runbook.ts';

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const BADGE: Record<string, string> = {
  DEPLOYED: C.green('DEPLOYED'),
  CUTOVER: C.green('CUTOVER'),
  ROLLED_BACK: C.yellow('ROLLED_BACK'),
  NEEDS_APPROVAL: C.yellow('NEEDS_APPROVAL'),
  FAILED: C.red('REFUSED'),
};

function render(s: RunState, p: FakeProviders, verdict: string | null) {
  const servers = p.calls.filter((c) => c.tool === 'hetzner__server_create').length;
  const dns = p.calls.filter((c) => c.tool === 'cloudflare__dns_upsert').length;
  for (const line of s.log) console.log('  ' + C.dim(line));
  if (s.error) console.log('  ' + C.red(`error  ${s.error}`));
  console.log(
    `  ${BADGE[s.status] ?? s.status}  ` +
      C.dim(
        `servers_bought=${servers} dns_writes=${dns} committed=$${s.cost_committed_usd}/mo next=${s.next_owner}`,
      ),
  );
  console.log(verdict === null ? '  ' + C.green('PASS') : '  ' + C.red(`FAIL — ${verdict}`));
}

async function main() {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string' },
      list: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(`Pilot (Varsiko Agent 4) — demo harness

  npm run pilot                      run every scenario
  npm run pilot -- --scenario happy  run one
  npm run pilot -- --list            list scenarios
  npm run pilot -- --json            machine-readable results

No network calls, no spend: FakeProviders drives the real runbook, guard and ledger.`);
    return;
  }

  if (values.list) {
    for (const s of SCENARIOS) console.log(`  ${s.id.padEnd(16)} ${s.title}`);
    return;
  }

  const keys = devKeys();
  const chosen = values.scenario ? SCENARIOS.filter((s) => s.id === values.scenario) : SCENARIOS;
  if (!chosen.length) {
    console.error(`Unknown scenario. Try: ${SCENARIOS.map((s) => s.id).join(', ')}`);
    process.exit(2);
  }

  const results: { id: string; pass: boolean; status: string; detail: string | null }[] = [];
  for (const sc of chosen) {
    const { state, providers, expect } = await sc.run(keys);
    const verdict = expect(state, providers);
    results.push({ id: sc.id, pass: verdict === null, status: state.status, detail: verdict });
    if (!values.json) {
      console.log('');
      console.log(C.bold(`▸ ${sc.title}`));
      console.log('  ' + C.cyan(sc.proves));
      render(state, providers, verdict);
    }
  }

  const failed = results.filter((r) => !r.pass);
  if (values.json) {
    console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
  } else {
    console.log('');
    console.log(
      failed.length === 0
        ? C.green(`  ${results.length}/${results.length} scenarios behaved as specified`)
        : C.red(`  ${failed.length}/${results.length} scenarios FAILED`),
    );
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
