import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { handleRpc, type AuditLog, type RpcRequest } from './mcp.ts';
import type { GatewayDeps } from './tools.ts';

const MAX_BODY = 1_000_000;

/** Compares digests, so length differences do not leak through timing. */
export function bearerOk(header: string | undefined, expected: string): boolean {
  const given = /^Bearer (.+)$/.exec(header ?? '')?.[1] ?? '';
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createGatewayServer(
  deps: GatewayDeps,
  opts: { bearerToken: string; log?: AuditLog },
): Server {
  const log = opts.log ?? ((e) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...e })));

  return createServer(async (req, res) => {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/healthz') return send(200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/mcp') return send(404, { error: 'not found' });

    if (!bearerOk(req.headers.authorization, opts.bearerToken)) {
      log({ outcome: 'unauthenticated' });
      return send(401, { error: 'unauthorized' });
    }

    let parsed: RpcRequest;
    try {
      parsed = JSON.parse(await readBody(req)) as RpcRequest;
    } catch {
      return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }

    const out = await handleRpc(deps, parsed, log);
    if (out === null) return send(202); // notification accepted
    return send(200, out);
  });
}
