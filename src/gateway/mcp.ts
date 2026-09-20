import { ProviderError } from './clients/http.ts';
import { ToolError, TOOLS, type GatewayDeps, type Role } from './tools.ts';

export interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export type RpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

export type AuditLog = (entry: Record<string, unknown>) => void;

const ok = (id: RpcRequest['id'], result: unknown): RpcResponse => ({ jsonrpc: '2.0', id: id ?? null, result });
const err = (id: RpcRequest['id'], code: number, message: string): RpcResponse => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

/**
 * Minimal MCP (JSON-RPC 2.0) server surface: initialize, ping, tools/list, tools/call.
 * Tool failures are returned as `isError` results (the MCP convention), so Nasiko and the
 * caller can tell a refused action from a transport failure.
 */
export async function handleRpc(
  deps: GatewayDeps,
  req: RpcRequest,
  log: AuditLog = () => {},
  role: Role = 'agent',
): Promise<RpcResponse | null> {
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') return err(req.id, -32600, 'invalid request');
  if (req.id === undefined) return null; // notification: no response

  switch (req.method) {
    case 'initialize':
      return ok(req.id, {
        protocolVersion: typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'varsiko-mandate-gateway', version: '0.1.0' },
      });

    case 'ping':
      return ok(req.id, {});

    case 'tools/list':
      return ok(req.id, {
        // A role only ever sees the tools it may call.
        tools: TOOLS.filter((t) => t.role === role).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });

    case 'tools/call': {
      const name = req.params?.name;
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return err(req.id, -32602, `unknown tool: ${String(name)}`);

      const started = Date.now();
      // `audit` lets a handler add fields (mandate id, registered address) to its own log line.
      // Never a token or cloud-init content: handlers only pass identifiers.
      const extra: Record<string, unknown> = {};
      const base = { tool: tool.name, role, run_id: typeof args.run_id === 'string' ? args.run_id : undefined };
      if (tool.role !== role) {
        log({ ...base, outcome: 'refused', code: 'FORBIDDEN_ROLE', ms: 0 });
        return ok(req.id, {
          content: [{ type: 'text', text: JSON.stringify({ error: 'FORBIDDEN_ROLE', message: `${tool.name} is not available to this credential` }) }],
          isError: true,
        });
      }
      try {
        const result = await tool.handler(args, deps, { audit: (e) => Object.assign(extra, e) });
        log({ ...base, ...extra, outcome: 'ok', ms: Date.now() - started });
        return ok(req.id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
      } catch (e) {
        // A provider failure outside the write-ahead path must still say whether it was a
        // definitive rejection or an unknown outcome, or the caller cannot tell a glitch
        // (retry) from a refusal (stop) and would clean up a healthy server.
        const code =
          e instanceof ToolError
            ? e.code
            : e instanceof ProviderError
              ? e.definitive
                ? 'PROVIDER_REJECTED'
                : 'PROVIDER_AMBIGUOUS'
              : 'INTERNAL';
        // ProviderError text is already sanitised and length-capped in http.ts. Anything
        // else is not echoed: it could carry arbitrary response text.
        const message = e instanceof ToolError || e instanceof ProviderError ? e.message : 'internal error';
        log({ ...base, ...extra, outcome: 'refused', code, ms: Date.now() - started });
        return ok(req.id, {
          content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }],
          isError: true,
        });
      }
    }

    default:
      return err(req.id, -32601, `unknown method: ${req.method}`);
  }
}
