/**
 * Nasiko speaks A2A 1.0 method names; accept both 1.0 and 0.3 forms.
 */
export const METHOD_MAP: Record<string, string> = {
  SendMessage: 'message/send',
  SendStreamingMessage: 'message/stream',
  GetTask: 'tasks/get',
  CancelTask: 'tasks/cancel',
  TaskResubscription: 'tasks/resubscribe',
};

export const ROLE_MAP: Record<string, string> = {
  ROLE_USER: 'user',
  ROLE_AGENT: 'agent',
};

function normalizeMessage(msg: Record<string, unknown>): void {
  const role = msg.role;
  if (typeof role === 'string' && role in ROLE_MAP) msg.role = ROLE_MAP[role];
  const parts = msg.parts;
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    const p = part as Record<string, unknown>;
    if ('kind' in p) continue;
    if ('text' in p) p.kind = 'text';
    else if ('data' in p) p.kind = 'data';
    else if ('file' in p) p.kind = 'file';
  }
}

export function rewriteRpc(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const body = payload as Record<string, unknown>;
  const method = body.method;
  if (typeof method === 'string' && method in METHOD_MAP) body.method = METHOD_MAP[method];
  const params = body.params;
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const message = (params as Record<string, unknown>).message;
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      normalizeMessage(message as Record<string, unknown>);
    }
  }
  return body;
}

export function extractText(message: Record<string, unknown> | undefined): string {
  if (!message) return '';
  const parts = message.parts;
  if (!Array.isArray(parts)) return '';
  const chunks: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;
    if (typeof p.text === 'string') chunks.push(p.text);
    else if (p.data && typeof p.data === 'object') chunks.push(JSON.stringify(p.data));
  }
  return chunks.join('\n').trim();
}

export function extractNasikoToken(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers['x-nasiko-agent-token'] ?? headers['X-Nasiko-Agent-Token'];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === 'string' ? raw : undefined;
}

export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled';

export function makeTask(opts: {
  id: string;
  contextId: string;
  state: TaskState;
  message?: string;
  artifacts?: { name: string; text?: string; data?: unknown }[];
}): Record<string, unknown> {
  const artifacts = (opts.artifacts ?? []).map((a) => {
    const parts: Record<string, unknown>[] = [];
    if (a.data !== undefined) {
      parts.push({ kind: 'data', data: a.data });
      parts.push({
        kind: 'text',
        text: typeof a.text === 'string' ? a.text : JSON.stringify(a.data),
      });
    } else if (a.text !== undefined) {
      parts.push({ kind: 'text', text: a.text });
    }
    return { name: a.name, parts };
  });
  return {
    id: opts.id,
    contextId: opts.contextId,
    status: {
      state: opts.state,
      message: opts.message
        ? { role: 'agent', parts: [{ kind: 'text', text: opts.message }] }
        : undefined,
    },
    artifacts,
    kind: 'task',
  };
}
