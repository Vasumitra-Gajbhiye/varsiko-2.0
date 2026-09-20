import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Sealed store for values that must never reach an agent: env var values, the Coolify
 * API token, the Coolify root password. AES-256-GCM, one file per entry.
 *
 * The `kind` is bound in as AAD, so a sealed env blob cannot be opened as a token or
 * vice versa even by code that holds the key.
 */
export class Vault {
  readonly #key: Buffer;
  readonly #dir: string;

  constructor(dir: string, keyHex: string) {
    if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error('VAULT_KEY must be 32 bytes as 64 hex chars');
    this.#key = Buffer.from(keyHex, 'hex');
    this.#dir = dir;
  }

  #path(name: string) {
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(name)) throw new Error('bad vault name');
    return join(this.#dir, name.replace(/:/g, '_') + '.json');
  }

  async put(kind: string, name: string, value: unknown, ttlMs: number, now = Date.now()): Promise<string> {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#key, iv);
    c.setAAD(Buffer.from(kind));
    const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    await mkdir(this.#dir, { recursive: true });
    await writeFile(
      this.#path(name),
      JSON.stringify({
        kind,
        exp: now + ttlMs,
        iv: iv.toString('base64'),
        tag: c.getAuthTag().toString('base64'),
        ct: ct.toString('base64'),
      }),
      { mode: 0o600 },
    );
    return `sealed:${name}`;
  }

  async get<T>(kind: string, name: string, now = Date.now()): Promise<T | null> {
    let raw: string;
    try {
      raw = await readFile(this.#path(name.replace(/^sealed:/, '')), 'utf8');
    } catch {
      return null;
    }
    const f = JSON.parse(raw) as { kind: string; exp: number; iv: string; tag: string; ct: string };
    if (f.kind !== kind || f.exp < now) return null;
    try {
      const d = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(f.iv, 'base64'));
      d.setAAD(Buffer.from(kind));
      d.setAuthTag(Buffer.from(f.tag, 'base64'));
      return JSON.parse(
        Buffer.concat([d.update(Buffer.from(f.ct, 'base64')), d.final()]).toString('utf8'),
      ) as T;
    } catch {
      return null; // wrong key or tampered file: indistinguishable from absent, on purpose
    }
  }

  async delete(name: string) {
    await rm(this.#path(name.replace(/^sealed:/, '')), { force: true });
  }
}
