import { isIP } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { signAuditorToken } from '../pilot/auditor.ts';
import { DEFAULT_KEY_DIR, KEY_FILES } from './keygen.ts';
import { runMain, UsageError, type CliIo } from './io.ts';

export const DEFAULT_AUDITOR_DIR = '.local/auditor';

/**
 * Stands in for Agent 5 (the Auditor) so cutover can be tested before it exists. The token
 * is a signed PASS bound to ONE mandate and ONE server IP; it is the only evidence the
 * gateway accepts for a DNS change, so this command is as sensitive as the auditor key.
 */
export async function auditorTokenCommand(
  argv: string[],
  io: CliIo,
  deps: { now?: () => Date } = {},
): Promise<number> {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      'mandate-file': { type: 'string' },
      'server-ip': { type: 'string' },
      'ttl-minutes': { type: 'string', default: '60' },
      key: { type: 'string', default: join(DEFAULT_KEY_DIR, KEY_FILES.auditorPrivate) },
      'out-dir': { type: 'string', default: DEFAULT_AUDITOR_DIR },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (v.help) {
    io.out(`Usage: npm run auditor-token -- --mandate-file .local/mandates/mdt_x.json --server-ip 1.2.3.4 [--ttl-minutes 60]

Signs an Auditor PASS token for one mandate and one server IP (testing stand-in for Agent 5).`);
    return 0;
  }
  if (!v['mandate-file']) throw new UsageError('--mandate-file is required');
  if (!v['server-ip'] || isIP(v['server-ip']) === 0) throw new UsageError('--server-ip must be an IP address');
  const ttl = Number(v['ttl-minutes']);
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 1440) throw new UsageError('--ttl-minutes must be in (0, 1440]');

  const file = JSON.parse(
    await readFile(v['mandate-file'], 'utf8').catch(() => {
      throw new UsageError(`cannot read ${v['mandate-file']}`);
    }),
  ) as { mandate?: { mandate_id?: string } };
  const mandateId = file.mandate?.mandate_id;
  if (!mandateId) throw new UsageError(`${v['mandate-file']} has no mandate.mandate_id`);

  const keyPem = await readFile(v.key!, 'utf8').catch(() => {
    throw new UsageError(`cannot read auditor key ${v.key} (run \`npm run keygen\`?)`);
  });

  const now = (deps.now ?? (() => new Date()))();
  const token = signAuditorToken(
    {
      mandate_id: mandateId,
      server_ip: v['server-ip'],
      verdict: 'PASS',
      iat: now.toISOString(),
      exp: new Date(now.getTime() + ttl * 60_000).toISOString(),
    },
    keyPem,
  );

  await mkdir(v['out-dir']!, { recursive: true });
  const out = join(v['out-dir']!, `${mandateId}.token`);
  await writeFile(out, token, { mode: 0o600 });
  io.out(`Auditor PASS for ${mandateId} @ ${v['server-ip']}, valid ${ttl} min, written to ${out.replace(/\\/g, '/')}`);
  io.out('This token authorises a DNS cutover for that server only; do not share it.');
  return 0;
}

if (import.meta.main) await runMain((argv, io) => auditorTokenCommand(argv, io));
