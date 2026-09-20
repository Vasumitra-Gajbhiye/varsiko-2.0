import { readFileSync } from 'node:fs';

export interface GatewayConfig {
  port: number;
  /** What Nasiko's connector sends as `Authorization: Bearer ...` to reach this server. */
  bearerToken: string;
  dataDir: string;
  vaultKey: string;
  mandatePublicKey: string;
  auditorPublicKey?: string;
  hetznerToken: string;
  hetznerSshKeys: string[];
  hetznerFirewallId?: number;
  /**
   * Coolify's API listens on plain HTTP :8000 until a domain and TLS are configured, and
   * we send it a bearer token and every migrated env var. Unless a Hetzner firewall
   * restricts :8000 to this gateway, that traffic is readable on the path. Refuse to
   * provision without a firewall unless the operator explicitly accepts the risk.
   */
  allowInsecureCoolifyHttp: boolean;
  /** Passed to Coolify's own allowed_ips so the API only answers this host. */
  gatewayEgressIp?: string;
  appPort: string;
  cloudflareToken?: string;
  vercelToken?: string;
  vercelTeamId?: string;
  anakinKey?: string;
  cloudInitTemplatePath: string;
}

const readKey = (path: string | undefined, name: string, required: boolean): string | undefined => {
  if (!path) {
    if (required) throw new Error(`${name} is required`);
    return undefined;
  }
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Error(`${name}: cannot read ${path} (run \`npm run keygen\`?)`);
  }
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const missing: string[] = [];
  const need = (k: string) => {
    const v = env[k];
    if (!v) missing.push(k);
    return v ?? '';
  };

  const bearerToken = need('GATEWAY_BEARER_TOKEN');
  const vaultKey = need('VAULT_KEY');
  const hetznerToken = need('HETZNER_TOKEN');
  const sshKeys = need('HETZNER_SSH_KEYS');
  const mandateKeyFile = need('MANDATE_PUBLIC_KEY_FILE');
  if (missing.length) throw new Error(`missing required env: ${missing.join(', ')}`);

  if (bearerToken.length < 32) throw new Error('GATEWAY_BEARER_TOKEN must be at least 32 characters');

  const fw = env.HETZNER_FIREWALL_ID ? Number(env.HETZNER_FIREWALL_ID) : undefined;
  if (fw !== undefined && !Number.isInteger(fw)) throw new Error('HETZNER_FIREWALL_ID must be an integer');

  return {
    port: Number(env.PORT ?? 8787),
    bearerToken,
    dataDir: env.DATA_DIR ?? './data',
    vaultKey,
    mandatePublicKey: readKey(mandateKeyFile, 'MANDATE_PUBLIC_KEY_FILE', true)!,
    auditorPublicKey: readKey(env.AUDITOR_PUBLIC_KEY_FILE, 'AUDITOR_PUBLIC_KEY_FILE', false),
    hetznerToken,
    hetznerSshKeys: sshKeys.split(',').map((s) => s.trim()).filter(Boolean),
    hetznerFirewallId: fw,
    allowInsecureCoolifyHttp: env.ALLOW_INSECURE_COOLIFY_HTTP === 'true',
    gatewayEgressIp: env.GATEWAY_EGRESS_IP,
    appPort: env.APP_PORT ?? '3000',
    cloudflareToken: env.CLOUDFLARE_TOKEN,
    vercelToken: env.VERCEL_TOKEN,
    vercelTeamId: env.VERCEL_TEAM_ID,
    anakinKey: env.ANAKIN_API_KEY,
    cloudInitTemplatePath: env.CLOUD_INIT_TEMPLATE ?? './cloud-init/coolify.yaml',
  };
}
