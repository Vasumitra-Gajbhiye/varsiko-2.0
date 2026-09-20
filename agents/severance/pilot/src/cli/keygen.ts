import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { runMain, UsageError, type CliIo } from './io.ts';

export const KEY_FILES = {
  mandatePrivate: 'mandate.key.pem',
  mandatePublic: 'mandate.pub.pem',
  auditorPrivate: 'auditor.key.pem',
  auditorPublic: 'auditor.pub.pem',
} as const;

export const DEFAULT_KEY_DIR = '.local/keys';

export interface GeneratedKeys {
  dir: string;
  mandatePrivate: string;
  mandatePublic: string;
  auditorPrivate: string;
  auditorPublic: string;
}

/**
 * Writes two Ed25519 key pairs (PKCS8 private, SPKI public, PEM). Private files are
 * 0600 where the OS honours it. Refuses to overwrite ANY existing key unless `force`,
 * because replacing the mandate key silently invalidates every mandate already issued.
 */
export async function generateKeyFiles(dir: string, opts: { force?: boolean } = {}): Promise<GeneratedKeys> {
  const paths = Object.fromEntries(Object.entries(KEY_FILES).map(([k, f]) => [k, join(dir, f)])) as Omit<GeneratedKeys, 'dir'>;
  const existing = Object.values(paths).filter((p) => existsSync(p));
  if (existing.length && !opts.force) {
    throw new UsageError(`refusing to overwrite existing keys (${existing.join(', ')}). Pass --force to replace them.`);
  }

  await mkdir(dir, { recursive: true });
  for (const [priv, pub] of [
    [paths.mandatePrivate, paths.mandatePublic],
    [paths.auditorPrivate, paths.auditorPublic],
  ] as const) {
    const kp = generateKeyPairSync('ed25519');
    await writeFile(priv, kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await chmod(priv, 0o600).catch(() => {}); // no-op on filesystems without POSIX modes
    await writeFile(pub, kp.publicKey.export({ type: 'spki', format: 'pem' }));
  }
  return { dir, ...paths };
}

export const suggestVaultKey = () => randomBytes(32).toString('hex');
export const suggestBearerToken = () => randomBytes(36).toString('base64url'); // 48 chars

export async function keygen(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string', default: DEFAULT_KEY_DIR },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    io.out(`Usage: npm run keygen [-- --dir .local/keys] [--force]

Creates Ed25519 mandate and auditor key pairs and prints suggested VAULT_KEY and
GATEWAY_BEARER_TOKEN values. Nothing is written to .env for you.`);
    return 0;
  }

  const keys = await generateKeyFiles(values.dir!, { force: values.force });
  const shown = (p: string) => relative(process.cwd(), p).replace(/\\/g, '/') || p;
  io.out('Created (private keys are operator-only; never commit or share them):');
  io.out(`  mandate signing key   ${shown(keys.mandatePrivate)}`);
  io.out(`  auditor signing key   ${shown(keys.auditorPrivate)}`);
  io.out('');
  io.out('Add to .env (these are suggestions; they are NOT written for you):');
  io.out(`  MANDATE_PUBLIC_KEY_FILE=${shown(keys.mandatePublic)}`);
  io.out(`  AUDITOR_PUBLIC_KEY_FILE=${shown(keys.auditorPublic)}`);
  io.out(`  VAULT_KEY=${suggestVaultKey()}`);
  io.out(`  GATEWAY_BEARER_TOKEN=${suggestBearerToken()}`);
  return 0;
}

if (import.meta.main) await runMain(keygen);
