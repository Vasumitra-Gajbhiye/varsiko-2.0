import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { SECRETS_TTL_MS } from '../gateway/tools.ts';
import { Vault } from '../gateway/vault.ts';
import { runMain, UsageError, type CliIo } from './io.ts';

interface CoolifySecrets {
  api_token?: string;
  root_password?: string;
}

const USAGE = `Usage:
  npm run vault -- put-coolify-token --mandate-id <id>      reads the token from STDIN
  npm run vault -- show-root-password --mandate-id <id> --reveal

Contingency for step B2: if the unattended Coolify token bootstrap does not work on a real
box, create an API token by hand in Coolify's UI and hand it to the gateway here.
Uses DATA_DIR and VAULT_KEY from the environment. Nothing is printed without --reveal.`;

export interface VaultDeps {
  /** Supplies the secret for put-coolify-token. Defaults to STDIN. Never taken from argv. */
  readStdin?: () => Promise<string>;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function vaultCommand(argv: string[], io: CliIo, deps: VaultDeps = {}): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'mandate-id': { type: 'string' },
      reveal: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [cmd] = positionals;
  if (v.help || !cmd) {
    io.out(USAGE);
    return v.help ? 0 : 2;
  }
  if (!['put-coolify-token', 'show-root-password'].includes(cmd)) throw new UsageError(`unknown command "${cmd}" (see --help)`);
  const mandateId = v['mandate-id'];
  if (!mandateId || !/^[A-Za-z0-9._-]{1,60}$/.test(mandateId)) throw new UsageError('--mandate-id is required and may only contain letters, digits, . _ -');

  const key = io.env.VAULT_KEY;
  if (!key) throw new UsageError('VAULT_KEY is not set (it must be the gateway\'s key)');
  let vault: Vault;
  try {
    vault = new Vault(join(io.env.DATA_DIR ?? './data', 'vault'), key);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const name = `coolify:${mandateId}`;
  const existing = await vault.get<CoolifySecrets>('coolify', name);

  if (cmd === 'put-coolify-token') {
    if (!existing) {
      throw new UsageError(
        `no Coolify entry for ${mandateId}. The gateway creates it when it provisions the server; ` +
          'run the migration up to the purchase first (or the entry has expired).',
      );
    }
    const token = (await (deps.readStdin ?? readAllStdin)()).trim();
    if (!token) throw new UsageError('no token on STDIN. Pipe it in: the token must never be an argument.');
    if (/\s/.test(token) || token.length < 16) throw new UsageError('that does not look like a Coolify API token (expected one line, 16+ characters)');
    // Merge: keep root_password and anything else already sealed.
    await vault.put('coolify', name, { ...existing, api_token: token }, SECRETS_TTL_MS);
    io.out(`Stored the Coolify API token for ${mandateId} (root password kept). Re-run from the health step.`);
    return 0;
  }

  // show-root-password
  if (!v.reveal) throw new UsageError('show-root-password prints an operator-only secret; add --reveal to print it once');
  if (!existing?.root_password) throw new UsageError(`no root password stored for ${mandateId} (missing or expired)`);
  io.err('WARNING: operator-only secret. Do not paste it into chat, tickets or logs.');
  io.out(existing.root_password);
  return 0;
}

if (import.meta.main) await runMain((argv, io) => vaultCommand(argv, io));
