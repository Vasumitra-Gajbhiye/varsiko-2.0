import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileLedger } from '../pilot/ledger.ts';
import { AnakinClient } from './clients/anakin.ts';
import { CloudflareClient } from './clients/cloudflare.ts';
import { CoolifyClient } from './clients/coolify.ts';
import { HetznerClient } from './clients/hetzner.ts';
import { VercelClient } from './clients/vercel.ts';
import { loadConfig } from './config.ts';
import { createGatewayServer } from './server.ts';
import { Vault } from './vault.ts';

let cfg: ReturnType<typeof loadConfig>;
try {
  cfg = loadConfig();
} catch (e) {
  // A config error is an operator mistake, not a crash: say what to fix, without a stack.
  console.error(`varsiko-mandate-gateway: ${(e as Error).message}`);
  process.exit(1);
}

const deps = {
  cfg,
  ledger: new FileLedger(join(cfg.dataDir, 'ledger.jsonl')),
  vault: new Vault(join(cfg.dataDir, 'vault'), cfg.vaultKey),
  hetzner: new HetznerClient(cfg.hetznerToken),
  coolify: (ip: string, token: string) => new CoolifyClient(ip, token),
  cloudflare: cfg.cloudflareToken ? new CloudflareClient(cfg.cloudflareToken) : undefined,
  vercel: cfg.vercelToken ? new VercelClient(cfg.vercelToken, { teamId: cfg.vercelTeamId }) : undefined,
  anakin: cfg.anakinKey ? new AnakinClient(cfg.anakinKey) : undefined,
  cloudInitTemplate: readFileSync(cfg.cloudInitTemplatePath, 'utf8'),
};

const notes: string[] = [];
if (!cfg.hetznerFirewallId) notes.push('no HETZNER_FIREWALL_ID: server creation is refused unless ALLOW_INSECURE_COOLIFY_HTTP=true');
if (!deps.cloudflare) notes.push('CLOUDFLARE_TOKEN unset: DNS cutover tools disabled');
if (!deps.vercel) notes.push('VERCEL_TOKEN unset: env export disabled');
if (!deps.anakin) notes.push('ANAKIN_API_KEY unset: price cross-check disabled');
if (!cfg.operatorToken) notes.push('GATEWAY_OPERATOR_TOKEN unset: handoff prepare/register tools are disabled');
if (!cfg.auditorPublicKey) notes.push('AUDITOR_PUBLIC_KEY_FILE unset: DNS cutover cannot verify an Auditor token');

const server = createGatewayServer(deps, { bearerToken: cfg.bearerToken, operatorToken: cfg.operatorToken }).listen(cfg.port, () => {
  console.log(`varsiko-mandate-gateway listening on :${cfg.port}  (POST /mcp)`);
  for (const n of notes) console.log(`  note: ${n}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`${sig}: shutting down`);
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
