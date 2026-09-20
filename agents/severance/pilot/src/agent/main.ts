import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { generateKeyPairSync, createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteRpc } from './a2a-compat.ts';
import { handleRpc, PilotExecutor } from './executor.ts';
import { RunStore } from './run-store.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const cardPath = join(ROOT, 'AgentCard.json');
const agentCard = JSON.parse(readFileSync(cardPath, 'utf8')) as Record<string, unknown>;

function loadPublicKey(): KeyObject {
  const path = process.env.MANDATE_PUBLIC_KEY_FILE;
  if (path && existsSync(path)) {
    return createPublicKey(readFileSync(path, 'utf8'));
  }
  if (process.env.PILOT_OFFLINE === '1') {
    return generateKeyPairSync('ed25519').publicKey;
  }
  console.error('severance-pilot: MANDATE_PUBLIC_KEY_FILE is required when PILOT_OFFLINE is not set');
  process.exit(1);
}

const offline = process.env.PILOT_OFFLINE === '1';
const dataDir = process.env.DATA_DIR ?? './data';
const executor = new PilotExecutor({
  store: new RunStore(join(dataDir, 'runs')),
  offline,
  publicKey: loadPublicKey(),
  signingSecret: process.env.MANDATE_SIGNING_SECRET ?? '',
  dataDir,
  mcpGatewayUrl: process.env.MCP_GATEWAY_URL,
  envToken: process.env.NASIKO_AGENT_TOKEN,
});

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
};

const server = createServer(async (req, res) => {
  const url = req.url?.split('?')[0] ?? '/';
  try {
    if (req.method === 'GET' && (url === '/health' || url === '/healthz')) {
      sendJson(res, 200, { status: 'healthy', service: 'severance-pilot', offline });
      return;
    }
    if (
      req.method === 'GET' &&
      (url === '/.well-known/agent-card.json' ||
        url === '/.well-known/agent.json' ||
        url === '/AgentCard.json')
    ) {
      sendJson(res, 200, agentCard);
      return;
    }
    if (req.method === 'POST' && (url === '/' || url === '/jsonrpc' || url === '/a2a')) {
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw || 'null');
      } catch {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
        return;
      }
      const body = rewriteRpc(parsed) as Record<string, unknown>;
      const headers: Record<string, string | string[] | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = v;
      const reply = await handleRpc(body, headers, executor);
      if (reply.error) {
        sendJson(res, 200, { jsonrpc: '2.0', id: reply.id, error: reply.error });
        return;
      }
      sendJson(res, 200, { jsonrpc: '2.0', id: reply.id, result: reply.result });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    });
  }
});

const port = Number(process.env.PORT || 8000);
server.listen(port, '0.0.0.0', () => {
  console.error(`severance-pilot listening on ${port} (offline=${offline})`);
});
