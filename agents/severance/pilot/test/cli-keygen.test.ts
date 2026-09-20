import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { generateKeyFiles, keygen } from '../src/cli/keygen.ts';
import { UsageError } from '../src/cli/io.ts';
import { signAuditorToken, verifyAuditorToken } from '../src/pilot/auditor.ts';
import { signMandate, verifyMandate } from '../src/pilot/mandate.ts';
import { devMandate } from '../src/pilot/demo.ts';
import { captureIo } from './helpers/cli.ts';

describe('keygen', () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'keygen-'));
  });
  after(() => rm(root, { recursive: true, force: true }));

  it('creates PEM key pairs that round-trip a mandate and an auditor token', async () => {
    const keys = await generateKeyFiles(join(root, 'a'));
    const [mPriv, mPub, aPriv, aPub] = await Promise.all(
      [keys.mandatePrivate, keys.mandatePublic, keys.auditorPrivate, keys.auditorPublic].map((p) => readFile(p, 'utf8')),
    );
    assert.match(mPriv!, /BEGIN PRIVATE KEY/);
    assert.match(mPub!, /BEGIN PUBLIC KEY/);
    assert.equal(createPrivateKey(mPriv!).asymmetricKeyType, 'ed25519');
    assert.equal(createPublicKey(aPub!).asymmetricKeyType, 'ed25519');

    const mandate = devMandate({ exp: '2999-01-01T00:00:00Z' });
    const now = new Date('2026-09-20T15:00:00Z');
    const v = verifyMandate(signMandate(mandate, mPriv!), { publicKey: mPub!, now });
    assert.equal(v.ok, true);

    const tok = signAuditorToken(
      { mandate_id: 'mdt_1', server_ip: '1.2.3.4', verdict: 'PASS', iat: '2026-01-01T00:00:00Z', exp: '2999-01-01T00:00:00Z' },
      aPriv!,
    );
    assert.equal(verifyAuditorToken(tok, { publicKey: aPub!, mandate_id: 'mdt_1', server_ip: '1.2.3.4' }).ok, true);
  });

  it('uses different keys for mandates and auditor tokens', async () => {
    const keys = await generateKeyFiles(join(root, 'b'));
    const mandate = devMandate({ exp: '2999-01-01T00:00:00Z' });
    const now = new Date('2026-09-20T15:00:00Z');
    const token = signMandate(mandate, await readFile(keys.mandatePrivate, 'utf8'));
    const wrong = verifyMandate(token, { publicKey: await readFile(keys.auditorPublic, 'utf8'), now });
    assert.equal(wrong.ok, false);
  });

  it('restricts private key files to the owner where the OS supports it', { skip: process.platform === 'win32' }, async () => {
    const keys = await generateKeyFiles(join(root, 'c'));
    assert.equal((await stat(keys.mandatePrivate)).mode & 0o777, 0o600);
    assert.equal((await stat(keys.auditorPrivate)).mode & 0o777, 0o600);
  });

  it('refuses to overwrite existing keys without --force, and replaces them with it', async () => {
    const dir = join(root, 'd');
    const first = await generateKeyFiles(dir);
    const before = await readFile(first.mandatePrivate, 'utf8');
    await assert.rejects(generateKeyFiles(dir), UsageError);
    assert.equal(await readFile(first.mandatePrivate, 'utf8'), before, 'a refused run must not touch the key');
    await generateKeyFiles(dir, { force: true });
    assert.notEqual(await readFile(first.mandatePrivate, 'utf8'), before);
  });

  it('prints suggestions and paths but never writes them to disk or leaks a private key', async () => {
    const dir = join(root, 'e');
    const { io, text } = captureIo();
    assert.equal(await keygen(['--dir', dir], io), 0);
    const out = text();
    assert.match(out, /VAULT_KEY=[0-9a-f]{64}\b/);
    assert.match(out, /GATEWAY_BEARER_TOKEN=\S{48,}/);
    assert.match(out, /MANDATE_PUBLIC_KEY_FILE=.*mandate\.pub\.pem/);
    assert.match(out, /AUDITOR_PUBLIC_KEY_FILE=.*auditor\.pub\.pem/);
    assert.ok(!out.includes('PRIVATE KEY'), 'private key material must never be printed');
    await assert.rejects(keygen(['--dir', dir], captureIo().io), UsageError);
  });
});
