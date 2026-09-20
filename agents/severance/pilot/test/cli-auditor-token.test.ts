import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { auditorTokenCommand } from '../src/cli/auditor-token.ts';
import { UsageError } from '../src/cli/io.ts';
import { generateKeyFiles } from '../src/cli/keygen.ts';
import { verifyAuditorToken } from '../src/pilot/auditor.ts';
import { captureIo } from './helpers/cli.ts';

const NOW = new Date('2026-09-20T15:00:00Z');

describe('auditor-token command', () => {
  let dir: string;
  let args: string[];
  let pub: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'auditor-'));
    const keys = await generateKeyFiles(join(dir, 'keys'));
    pub = await readFile(keys.auditorPublic, 'utf8');
    await writeFile(join(dir, 'mdt_1.json'), JSON.stringify({ mandate: { mandate_id: 'mdt_1' }, token: 'irrelevant' }));
    args = ['--mandate-file', join(dir, 'mdt_1.json'), '--key', keys.auditorPrivate, '--out-dir', join(dir, 'tok')];
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it('writes a token that verifies for that IP and is rejected for a different one', async () => {
    const cap = captureIo();
    assert.equal(await auditorTokenCommand([...args, '--server-ip', '1.2.3.4', '--ttl-minutes', '30'], cap.io, { now: () => NOW }), 0);
    const token = await readFile(join(dir, 'tok', 'mdt_1.token'), 'utf8');

    const ok = verifyAuditorToken(token, { publicKey: pub, mandate_id: 'mdt_1', server_ip: '1.2.3.4', now: NOW });
    assert.equal(ok.ok, true);
    assert.equal(ok.ok && ok.claims.exp, '2026-09-20T15:30:00.000Z');

    const wrongIp = verifyAuditorToken(token, { publicKey: pub, mandate_id: 'mdt_1', server_ip: '5.6.7.8', now: NOW });
    assert.deepEqual(wrongIp.ok === false && wrongIp.code, 'AUDITOR_WRONG_SERVER');
    const wrongMandate = verifyAuditorToken(token, { publicKey: pub, mandate_id: 'mdt_2', server_ip: '1.2.3.4', now: NOW });
    assert.deepEqual(wrongMandate.ok === false && wrongMandate.code, 'AUDITOR_WRONG_MANDATE');
    const expired = verifyAuditorToken(token, { publicKey: pub, mandate_id: 'mdt_1', server_ip: '1.2.3.4', now: new Date('2026-09-20T16:00:00Z') });
    assert.deepEqual(expired.ok === false && expired.code, 'AUDITOR_EXPIRED');

    assert.ok(!cap.text().includes(token), 'the token must not be printed');
  });

  it('rejects a missing or malformed IP and an unreadable mandate file', async () => {
    await assert.rejects(auditorTokenCommand(args, captureIo().io), UsageError);
    await assert.rejects(auditorTokenCommand([...args, '--server-ip', 'not-an-ip'], captureIo().io), UsageError);
    await assert.rejects(
      auditorTokenCommand(['--mandate-file', join(dir, 'nope.json'), '--server-ip', '1.2.3.4'], captureIo().io),
      /cannot read/,
    );
  });
});
