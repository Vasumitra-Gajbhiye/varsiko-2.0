import net from 'node:net';

/**
 * A tiny Redis speaking real RESP over a real socket, for tests.
 *
 * Just enough commands for the KV shim, the ISR cache handler and a Next.js
 * build that touches Redis while prerendering. It exists so those are tested
 * against ioredis's actual wire behaviour rather than a mock of ioredis.
 */

type Value =
  | { type: 'string'; value: string }
  | { type: 'hash'; value: Map<string, string> }
  | { type: 'zset'; value: Map<string, number> }
  | { type: 'list'; value: string[] }
  | { type: 'set'; value: Set<string> };

type Entry = Value & { expireAt?: number };

export type FakeRedis = {
  port: number;
  url: string;
  /** Snapshot of every live key, for assertions. */
  keys(): string[];
  raw(key: string): string | undefined;
  close(): Promise<void>;
};

const ok = '+OK\r\n';
const int = (n: number) => `:${n}\r\n`;
const bulk = (s: string | null) => (s === null ? '$-1\r\n' : `$${Buffer.byteLength(s)}\r\n${s}\r\n`);
const arr = (items: (string | null)[]) => `*${items.length}\r\n${items.map(bulk).join('')}`;
const err = (m: string) => `-ERR ${m}\r\n`;

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** Parse as many complete RESP array commands as the buffer holds. */
function parse(buffer: Buffer): { commands: string[][]; rest: Buffer } {
  const commands: string[][] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0x2a) break; // '*'
    const headerEnd = buffer.indexOf('\r\n', offset);
    if (headerEnd === -1) break;
    const count = Number(buffer.toString('utf8', offset + 1, headerEnd));
    let cursor = headerEnd + 2;
    const args: string[] = [];
    let complete = true;
    for (let i = 0; i < count; i++) {
      const lenEnd = buffer.indexOf('\r\n', cursor);
      if (lenEnd === -1) {
        complete = false;
        break;
      }
      const len = Number(buffer.toString('utf8', cursor + 1, lenEnd));
      const start = lenEnd + 2;
      if (start + len + 2 > buffer.length) {
        complete = false;
        break;
      }
      args.push(buffer.toString('utf8', start, start + len));
      cursor = start + len + 2;
    }
    if (!complete) break;
    commands.push(args);
    offset = cursor;
  }
  return { commands, rest: buffer.subarray(offset) };
}

export async function startFakeRedis(): Promise<FakeRedis> {
  const store = new Map<string, Entry>();

  const live = (key: string): Entry | undefined => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expireAt !== undefined && entry.expireAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };

  const typed = <T extends Value['type']>(key: string, type: T, make: () => Extract<Value, { type: T }>['value']) => {
    const existing = live(key);
    if (existing && existing.type !== type) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    if (existing) return existing.value as Extract<Value, { type: T }>['value'];
    const value = make();
    store.set(key, { type, value } as Entry);
    return value;
  };

  const run = (args: string[]): string => {
    const [name = '', ...a] = args;
    const cmd = name.toUpperCase();
    const key = a[0] ?? '';

    switch (cmd) {
      case 'PING':
        return '+PONG\r\n';
      case 'INFO':
        return bulk('# Server\r\nredis_version:7.2.0\r\nloading:0\r\n');
      case 'CLIENT':
      case 'SELECT':
      case 'AUTH':
        return ok;
      case 'QUIT':
        return ok;

      case 'SET': {
        const opts = a.slice(2).map((s) => s.toUpperCase());
        const nx = opts.includes('NX');
        const xx = opts.includes('XX');
        if (nx && live(key)) return bulk(null);
        if (xx && !live(key)) return bulk(null);
        const entry: Entry = { type: 'string', value: a[1] ?? '' };
        const px = opts.indexOf('PX');
        const ex = opts.indexOf('EX');
        if (ex !== -1) entry.expireAt = Date.now() + Number(a[2 + ex + 1]) * 1000;
        if (px !== -1) entry.expireAt = Date.now() + Number(a[2 + px + 1]);
        store.set(key, entry);
        return ok;
      }
      case 'SETEX':
        store.set(key, { type: 'string', value: a[2] ?? '', expireAt: Date.now() + Number(a[1]) * 1000 });
        return ok;
      case 'GET': {
        const e = live(key);
        return bulk(e && e.type === 'string' ? e.value : null);
      }
      case 'MGET':
        return arr(a.map((k) => { const e = live(k); return e && e.type === 'string' ? e.value : null; }));
      case 'DEL': {
        let n = 0;
        for (const k of a) if (live(k)) { store.delete(k); n++; }
        return int(n);
      }
      case 'EXISTS':
        return int(a.filter((k) => live(k)).length);
      case 'INCR':
      case 'INCRBY':
      case 'DECR': {
        const e = live(key);
        const current = e && e.type === 'string' ? Number(e.value) : 0;
        const by = cmd === 'INCRBY' ? Number(a[1]) : cmd === 'DECR' ? -1 : 1;
        const next = current + by;
        store.set(key, { type: 'string', value: String(next), expireAt: e?.expireAt });
        return int(next);
      }
      case 'EXPIRE': {
        const e = live(key);
        if (!e) return int(0);
        e.expireAt = Date.now() + Number(a[1]) * 1000;
        return int(1);
      }
      case 'TTL': {
        const e = live(key);
        if (!e) return int(-2);
        return int(e.expireAt === undefined ? -1 : Math.ceil((e.expireAt - Date.now()) / 1000));
      }

      case 'HSET': {
        const h = typed(key, 'hash', () => new Map());
        let added = 0;
        for (let i = 1; i < a.length; i += 2) {
          if (!h.has(a[i]!)) added++;
          h.set(a[i]!, a[i + 1] ?? '');
        }
        return int(added);
      }
      case 'HGET':
        return bulk((live(key)?.type === 'hash' ? (live(key)!.value as Map<string, string>).get(a[1]!) : undefined) ?? null);
      case 'HMGET': {
        const h = live(key)?.type === 'hash' ? (live(key)!.value as Map<string, string>) : new Map<string, string>();
        return arr(a.slice(1).map((f) => h.get(f) ?? null));
      }
      case 'HGETALL': {
        const h = live(key)?.type === 'hash' ? (live(key)!.value as Map<string, string>) : new Map<string, string>();
        return arr([...h.entries()].flat());
      }
      case 'HDEL': {
        const h = live(key)?.type === 'hash' ? (live(key)!.value as Map<string, string>) : undefined;
        return int(h ? a.slice(1).filter((f) => h.delete(f)).length : 0);
      }
      case 'HINCRBY': {
        const h = typed(key, 'hash', () => new Map());
        const next = Number(h.get(a[1]!) ?? 0) + Number(a[2]);
        h.set(a[1]!, String(next));
        return int(next);
      }

      case 'ZADD': {
        const z = typed(key, 'zset', () => new Map());
        let added = 0;
        for (let i = 1; i < a.length; i += 2) {
          if (!z.has(a[i + 1]!)) added++;
          z.set(a[i + 1]!, Number(a[i]));
        }
        return int(added);
      }
      case 'ZINCRBY': {
        const z = typed(key, 'zset', () => new Map());
        const next = (z.get(a[2]!) ?? 0) + Number(a[1]);
        z.set(a[2]!, next);
        return bulk(String(next));
      }
      case 'ZSCORE': {
        const z = live(key)?.type === 'zset' ? (live(key)!.value as Map<string, number>) : undefined;
        const score = z?.get(a[1]!);
        return bulk(score === undefined ? null : String(score));
      }
      case 'ZREM': {
        const z = live(key)?.type === 'zset' ? (live(key)!.value as Map<string, number>) : undefined;
        return int(z ? a.slice(1).filter((m) => z.delete(m)).length : 0);
      }
      case 'ZRANGE': {
        const flags = a.slice(3).map((s) => s.toUpperCase());
        const z = live(key)?.type === 'zset' ? (live(key)!.value as Map<string, number>) : new Map<string, number>();
        let members = [...z.entries()].sort((x, y) => x[1] - y[1] || x[0].localeCompare(y[0]));
        if (flags.includes('REV')) members = members.reverse();
        const norm = (i: number) => (i < 0 ? members.length + i : i);
        const slice = members.slice(Math.max(norm(Number(a[1])), 0), norm(Number(a[2])) + 1);
        return arr(flags.includes('WITHSCORES') ? slice.flatMap(([m, s]) => [m, String(s)]) : slice.map(([m]) => m));
      }

      case 'LPUSH':
      case 'RPUSH': {
        const l = typed(key, 'list', () => []);
        for (const v of a.slice(1)) cmd === 'LPUSH' ? l.unshift(v) : l.push(v);
        return int(l.length);
      }
      case 'LRANGE': {
        const l = live(key)?.type === 'list' ? (live(key)!.value as string[]) : [];
        const norm = (i: number) => (i < 0 ? l.length + i : i);
        return arr(l.slice(Math.max(norm(Number(a[1])), 0), norm(Number(a[2])) + 1));
      }
      case 'LPOP': {
        const l = live(key)?.type === 'list' ? (live(key)!.value as string[]) : [];
        return bulk(l.shift() ?? null);
      }

      case 'SADD': {
        const s = typed(key, 'set', () => new Set());
        let added = 0;
        for (const v of a.slice(1)) if (!s.has(v)) { s.add(v); added++; }
        return int(added);
      }
      case 'SMEMBERS':
        return arr(live(key)?.type === 'set' ? [...(live(key)!.value as Set<string>)] : []);
      case 'SREM': {
        const s = live(key)?.type === 'set' ? (live(key)!.value as Set<string>) : undefined;
        return int(s ? a.slice(1).filter((v) => s.delete(v)).length : 0);
      }

      case 'SCAN': {
        const match = a[a.findIndex((x) => x.toUpperCase() === 'MATCH') + 1] ?? '*';
        const re = globToRegExp(match);
        const found = [...store.keys()].filter((k) => live(k) && re.test(k));
        return `*2\r\n${bulk('0')}${arr(found)}`;
      }

      default:
        return err(`unknown command '${name}'`);
    }
  };

  const server = net.createServer((socket) => {
    let pending: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const { commands, rest } = parse(pending);
      pending = rest;
      for (const args of commands) {
        try {
          socket.write(run(args));
          if (args[0]?.toUpperCase() === 'QUIT') socket.end();
        } catch (error) {
          socket.write(err(error instanceof Error ? error.message : String(error)));
        }
      }
    });
    socket.on('error', () => {});
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    url: `redis://127.0.0.1:${port}`,
    keys: () => [...store.keys()].filter((k) => live(k)),
    raw: (key) => {
      const e = live(key);
      return e && e.type === 'string' ? e.value : undefined;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

// Allow `tsx test/helpers/fake-redis.ts <port>` for manual and build-time use.
if (process.argv[1] && process.argv[1].endsWith('fake-redis.ts')) {
  const fake = await startFakeRedis();
  console.log(fake.url);
  process.on('SIGTERM', () => void fake.close().then(() => process.exit(0)));
}
