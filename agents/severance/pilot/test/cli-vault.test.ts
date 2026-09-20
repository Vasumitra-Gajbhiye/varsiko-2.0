import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { UsageError } from '../src/cli/io.ts';
import { vaultCommand } from '../src/cli/vault.ts';
import { Vault } from '../src/gateway/vault.ts';
import { captureIo } from './helpers/cli.ts';

const KEY = 'ab'.repeat(32);
const ROOT_PW = 'root-password-secret-0123456789';
const OLD_TOKEN = 'old-api-token-0123456789abcdef';
const NEW_TOKEN = '7|new-api-token-from-the-coolify-ui';

describe('vault helper', () => {
  let dir: string;
  let vault: Vault;
  const env = () => ({ VAULT_KEY: KEY, DATA_DIR: dir });

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vault-cli-'));
    vault = new Vault(join(dir, 'vault'), KEY);
    await vault.put('coolify', 'coolify:mdt_1', { api_token: OLD_TOKEN, root_password: ROOT_PW }, 3_600_000);
  });
  after(() => rm(dir, { recursive: true, force: true }));

  const secretsIn = (text: string) => [OLD_TOKEN, NEW_TOKEN, ROOT_PW].filter((s) => text.includes(s));

  it('put-coolify-token reads STDIN, replaces the token, keeps the root password, and prints no secret', async () => {
    const cap = captureIo({ env: env() });
    const code = await vaultCommand(['put-coolify-token', '--mandate-id', 'mdt_1'], cap.io, { readStdin: async () => `${NEW_TOKEN}\n` });
    assert.equal(code, 0);
    assert.deepEqual(secretsIn(cap.text()), []);
    const stored = await vault.get<{ api_token: string; root_password: string }>('coolify', 'coolify:mdt_1');
    assert.deepEqual(stored, { api_token: NEW_TOKEN, root_password: ROOT_PW });
  });

  it('the stored file is sealed: neither secret appears in plaintext on disk', async () => {
    const files = await readdir(join(dir, 'vault'));
    for (const f of files) {
      const raw = await readFile(join(dir, 'vault', f), 'utf8');
      assert.deepEqual(secretsIn(raw), [], f);
    }
  });

  it('never accepts the token as an argument', async () => {
    await assert.rejects(
      vaultCommand(['put-coolify-token', '--mandate-id', 'mdt_1', '--token', NEW_TOKEN], captureIo({ env: env() }).io, { readStdin: async () => NEW_TOKEN }),
      (e: unknown) => (e as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION',
    );
  });

  it('rejects an empty or malformed token and an unknown mandate', async () => {
    const put = (stdin: string, id = 'mdt_1') =>
      vaultCommand(['put-coolify-token', '--mandate-id', id], captureIo({ env: env() }).io, { readStdin: async () => stdin });
    await assert.rejects(put(''), /no token on STDIN/);
    await assert.rejects(put('two words here 0123456789'), /does not look like a Coolify API token/);
    await assert.rejects(put('short'), /does not look like a Coolify API token/);
    await assert.rejects(put(NEW_TOKEN, 'mdt_missing'), /no Coolify entry for mdt_missing/);
  });

  it('show-root-password prints nothing without --reveal', async () => {
    const cap = captureIo({ env: env() });
    await assert.rejects(vaultCommand(['show-root-password', '--mandate-id', 'mdt_1'], cap.io), UsageError);
    assert.deepEqual(secretsIn(cap.text()), []);
    assert.equal(cap.lines.length, 0);
  });

  it('show-root-password --reveal prints it once, with an operator-only warning', async () => {
    const cap = captureIo({ env: env() });
    assert.equal(await vaultCommand(['show-root-password', '--mandate-id', 'mdt_1', '--reveal'], cap.io), 0);
    assert.equal(cap.lines.filter((l) => l === ROOT_PW).length, 1);
    assert.match(cap.text(), /WARNING: operator-only secret/);
    assert.ok(!cap.text().includes(OLD_TOKEN) && !cap.text().includes(NEW_TOKEN), 'only the root password may be shown');
  });

  it('needs VAULT_KEY, a valid mandate id, and a known command', async () => {
    await assert.rejects(vaultCommand(['show-root-password', '--mandate-id', 'mdt_1', '--reveal'], captureIo({ env: {} }).io), /VAULT_KEY is not set/);
    await assert.rejects(vaultCommand(['show-root-password', '--mandate-id', 'mdt_1', '--reveal'], captureIo({ env: { VAULT_KEY: 'zz', DATA_DIR: dir } }).io), /VAULT_KEY must be/);
    await assert.rejects(vaultCommand(['show-root-password', '--mandate-id', '../etc', '--reveal'], captureIo({ env: env() }).io), UsageError);
    await assert.rejects(vaultCommand(['frobnicate', '--mandate-id', 'mdt_1'], captureIo({ env: env() }).io), /unknown command/);
  });

  it('a wrong key cannot read the entry (reported as missing, never as a decrypt error)', async () => {
    const cap = captureIo({ env: { VAULT_KEY: 'cd'.repeat(32), DATA_DIR: dir } });
    await assert.rejects(vaultCommand(['show-root-password', '--mandate-id', 'mdt_1', '--reveal'], cap.io), /no root password stored/);
    assert.deepEqual(secretsIn(cap.text()), []);
  });
});
