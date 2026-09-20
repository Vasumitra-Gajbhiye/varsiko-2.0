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

const cfg = loadConfig();

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
if (!cfg.auditorPublicKey) notes.push('AUDITOR_PUBLIC_KEY_FILE unset: DNS cutover cannot verify an Auditor token');

createGatewayServer(deps, { bearerToken: cfg.bearerToken }).listen(cfg.port, () => {
  console.log(`varsiko-mandate-gateway listening on :${cfg.port}  (POST /mcp)`);
  for (const n of notes) console.log(`  note: ${n}`);
});
