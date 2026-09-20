import { randomUUID, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { routeCandidate, type VpsCandidate } from '../pilot/candidates.ts';
import {
  candidateFromCart,
  looksLikeCartMandate,
  verifyCartMandate,
  type CartMandate,
} from '../pilot/cart-mandate.ts';
import { FileLedger, MemoryLedger, type Ledger } from '../pilot/ledger.ts';
import { verifyMandate } from '../pilot/mandate.ts';
import { FakeProviders, NasikoGateway, nasikoProviders, type Providers } from '../pilot/providers.ts';
import { advance, newRun, type RunContext, type RunState } from '../pilot/runbook.ts';
import {
  extractNasikoToken,
  extractText,
  makeTask,
  type TaskState,
} from './a2a-compat.ts';
import { RunStore } from './run-store.ts';

const SCHEMA_RUN = 'severance.pilot_run/v1';

export type AgentDeps = {
  store: RunStore;
  offline: boolean;
  publicKey: KeyObject | string;
  signingSecret: string;
  dataDir: string;
  mcpGatewayUrl?: string;
  envToken?: string;
};

function parseJsonSkill(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function looksLikeSpendToken(text: string): string | null {
  const trimmed = text.trim();
  // Compact signed mandate tokens from signMandate are base64url-ish with a dot separator,
  // or a JSON mandate + signature envelope. Accept anything verifyMandate can parse.
  if (trimmed.length > 40 && (trimmed.includes('.') || trimmed.includes('mandate_id'))) {
    return trimmed;
  }
  return null;
}

function providersFor(
  offline: boolean,
  token: string | undefined,
  mcpUrl: string | undefined,
  runId: string,
  mandateToken: string,
): Providers {
  if (offline || !mcpUrl || !token) return new FakeProviders();
  return nasikoProviders(new NasikoGateway({ url: mcpUrl, token }), {
    runId,
    mandate: mandateToken,
  });
}

function ledgerFor(offline: boolean, dataDir: string): Ledger {
  if (offline) return new MemoryLedger();
  return new FileLedger(join(dataDir, 'ledger.jsonl'));
}

function runArtifact(state: RunState, extra: Record<string, unknown> = {}) {
  return {
    schema: SCHEMA_RUN,
    run_id: state.run_id,
    mandate_id: state.mandate_id,
    step: state.step,
    status: state.status,
    lane: state.lane,
    cost_committed_usd: state.cost_committed_usd,
    next_owner: state.next_owner,
    error: state.error,
    artifacts: state.artifacts,
    ...extra,
  };
}

export class PilotExecutor {
  readonly #deps: AgentDeps;
  /** Parked cart mandates awaiting a spend mandate on the same contextId. */
  readonly #parked = new Map<string, { cart: CartMandate; routing: ReturnType<typeof routeCandidate> }>();

  constructor(deps: AgentDeps) {
    this.#deps = deps;
  }

  async handle(
    inboundText: string,
    headers: Record<string, string | string[] | undefined>,
    meta: { taskId: string; contextId: string },
  ): Promise<{ state: TaskState; message: string; artifacts: { name: string; text?: string; data?: unknown }[] }> {
    const skill = parseJsonSkill(inboundText);
    const token =
      extractNasikoToken(headers) ??
      this.#deps.envToken ??
      process.env.NASIKO_AGENT_TOKEN;

    if (skill?.skill === 'run.candidates') {
      return this.#candidates(skill);
    }
    if (skill?.skill === 'run.poll') {
      return this.#poll(String(skill.run_id ?? ''), token);
    }
    if (skill?.skill === 'run.cutover') {
      return this.#cutover(String(skill.run_id ?? ''), String(skill.auditor_token ?? ''), token);
    }
    if (skill?.skill === 'run.start') {
      const mandateToken = String(skill.mandate_token ?? skill.mandate ?? '');
      return this.#start(mandateToken, token, meta.contextId);
    }

    const cart = looksLikeCartMandate(inboundText);
    if (cart) return this.#handleCart(cart, meta.contextId);

    const parked = this.#parked.get(meta.contextId);
    const spend = looksLikeSpendToken(inboundText);
    if (parked && spend) {
      this.#parked.delete(meta.contextId);
      return this.#start(spend, token, meta.contextId);
    }
    if (spend) return this.#start(spend, token, meta.contextId);

    if (parked) {
      return {
        state: 'input-required',
        message:
          `Cart ${parked.cart.mandate_id} parked (lane=${parked.routing.lane}). ` +
          'Attach a signed Ed25519 spend mandate to start. Pilot never holds the signing key.',
        artifacts: [
          {
            name: 'pilot_park',
            data: {
              schema: SCHEMA_RUN,
              status: 'parked',
              mandate_id: parked.cart.mandate_id,
              lane: parked.routing.lane,
              reason: parked.routing.reason,
            },
          },
        ],
      };
    }

    return {
      state: 'input-required',
      message:
        'Send a severance.cart_mandate/v1, a signed spend mandate, or {skill:"run.poll"|"run.start"|"run.cutover"|"run.candidates", ...}.',
      artifacts: [],
    };
  }

  #candidates(skill: Record<string, unknown>) {
    const list = Array.isArray(skill.candidates) ? (skill.candidates as VpsCandidate[]) : [];
    const routed = list.map((c) => ({ candidate: c, routing: routeCandidate(c) }));
    return {
      state: 'completed' as TaskState,
      message: `Routed ${routed.length} candidates`,
      artifacts: [{ name: 'candidates', data: { schema: SCHEMA_RUN, routed } }],
    };
  }

  #handleCart(cart: CartMandate, contextId: string) {
    const secret = this.#deps.signingSecret;
    if (!secret) {
      return {
        state: 'failed' as TaskState,
        message: 'MANDATE_SIGNING_SECRET unset; cannot verify cart mandate',
        artifacts: [],
      };
    }
    const verified = verifyCartMandate(cart, secret);
    if (!verified.ok) {
      return {
        state: 'completed' as TaskState,
        message: `CART_REFUSED ${verified.code}: ${verified.reason}`,
        artifacts: [
          {
            name: 'pilot_refusal',
            data: { schema: SCHEMA_RUN, status: 'refused', code: verified.code, reason: verified.reason },
          },
        ],
      };
    }
    if (verified.mandate.approval?.status !== 'approved') {
      // Still route and park; human approval may arrive as a follow-up spend mandate.
    }
    const routing = routeCandidate(candidateFromCart(verified.mandate));
    this.#parked.set(contextId, { cart: verified.mandate, routing });
    return {
      state: 'input-required' as TaskState,
      message:
        `Cart ${verified.mandate.mandate_id} verified. Lane=${routing.lane} (${routing.reason}). ` +
        'Does not buy. Attach a signed Ed25519 spend mandate to start.',
      artifacts: [
        {
          name: 'pilot_park',
          data: {
            schema: SCHEMA_RUN,
            status: 'parked',
            mandate_id: verified.mandate.mandate_id,
            lane: routing.lane,
            reason: routing.reason,
            decision: verified.mandate.decision,
          },
        },
        {
          name: 'cart_mandate',
          data: verified.mandate,
          text: JSON.stringify(verified.mandate),
        },
      ],
    };
  }

  async #start(mandateToken: string, nasikoToken: string | undefined, contextId: string) {
    if (!mandateToken) {
      return {
        state: 'failed' as TaskState,
        message: 'run.start requires mandate_token',
        artifacts: [],
      };
    }
    const verified = verifyMandate(mandateToken, { publicKey: this.#deps.publicKey });
    if (!verified.ok) {
      return {
        state: 'completed' as TaskState,
        message: `START_REFUSED ${verified.code}: ${verified.reason}`,
        artifacts: [
          {
            name: 'pilot_refusal',
            data: { schema: SCHEMA_RUN, status: 'refused', code: verified.code, reason: verified.reason },
          },
        ],
      };
    }
    const runId = `run_${randomUUID().slice(0, 8)}`;
    const state = newRun(runId);
    const providers = providersFor(
      this.#deps.offline,
      nasikoToken,
      this.#deps.mcpGatewayUrl,
      runId,
      mandateToken,
    );
    const ledger = ledgerFor(this.#deps.offline, this.#deps.dataDir);
    const ctx: RunContext = {
      mandateToken,
      publicKey: this.#deps.publicKey,
      providers,
      ledger,
    };
    const advanced = await advance(state, ctx);
    await this.#deps.store.put({
      state: advanced,
      mandateToken,
      contextId,
      updatedAt: new Date().toISOString(),
    });
    const terminal =
      advanced.status === 'FAILED' ||
      advanced.status === 'ROLLED_BACK' ||
      advanced.status === 'DEPLOYED' ||
      advanced.status === 'CUTOVER';
    const parked =
      advanced.status === 'AWAITING_HUMAN_PURCHASE' || advanced.status === 'NEEDS_APPROVAL';
    return {
      state: (parked ? 'input-required' : terminal ? 'completed' : 'working') as TaskState,
      message: `run ${runId} ${advanced.status} at ${advanced.step}`,
      artifacts: [{ name: 'pilot_run', data: runArtifact(advanced), text: JSON.stringify(runArtifact(advanced)) }],
    };
  }

  async #poll(runId: string, nasikoToken: string | undefined) {
    if (!runId) {
      return { state: 'failed' as TaskState, message: 'run.poll requires run_id', artifacts: [] };
    }
    return this.#deps.store.withLock(runId, async () => {
      const stored = await this.#deps.store.get(runId);
      if (!stored) {
        return {
          state: 'failed' as TaskState,
          message: `unknown run_id ${runId}`,
          artifacts: [],
        };
      }
      const providers = providersFor(
        this.#deps.offline,
        nasikoToken,
        this.#deps.mcpGatewayUrl,
        runId,
        stored.mandateToken,
      );
      const ledger = ledgerFor(this.#deps.offline, this.#deps.dataDir);
      const ctx: RunContext = {
        mandateToken: stored.mandateToken,
        publicKey: this.#deps.publicKey,
        providers,
        ledger,
        auditorPassToken: stored.auditorPassToken,
      };
      const advanced = await advance(stored.state, ctx);
      await this.#deps.store.put({ ...stored, state: advanced });
      const terminal =
        advanced.status === 'FAILED' ||
        advanced.status === 'ROLLED_BACK' ||
        advanced.status === 'DEPLOYED' ||
        advanced.status === 'CUTOVER';
      const parked =
        advanced.status === 'AWAITING_HUMAN_PURCHASE' || advanced.status === 'NEEDS_APPROVAL';
      return {
        state: (parked ? 'input-required' : terminal ? 'completed' : 'working') as TaskState,
        message: `run ${runId} ${advanced.status} at ${advanced.step}`,
        artifacts: [
          { name: 'pilot_run', data: runArtifact(advanced), text: JSON.stringify(runArtifact(advanced)) },
        ],
      };
    });
  }

  async #cutover(runId: string, auditorToken: string, nasikoToken: string | undefined) {
    if (!runId || !auditorToken) {
      return {
        state: 'failed' as TaskState,
        message: 'run.cutover requires run_id and auditor_token',
        artifacts: [],
      };
    }
    return this.#deps.store.withLock(runId, async () => {
      const stored = await this.#deps.store.get(runId);
      if (!stored) {
        return { state: 'failed' as TaskState, message: `unknown run_id ${runId}`, artifacts: [] };
      }
      stored.auditorPassToken = auditorToken;
      // Jump to cutover step if deployed.
      if (stored.state.status === 'DEPLOYED') {
        stored.state = { ...stored.state, step: 'P8_CUTOVER', status: 'RUNNING' };
      }
      const providers = providersFor(
        this.#deps.offline,
        nasikoToken,
        this.#deps.mcpGatewayUrl,
        runId,
        stored.mandateToken,
      );
      const ledger = ledgerFor(this.#deps.offline, this.#deps.dataDir);
      const ctx: RunContext = {
        mandateToken: stored.mandateToken,
        publicKey: this.#deps.publicKey,
        providers,
        ledger,
        auditorPassToken: auditorToken,
      };
      const advanced = await advance(stored.state, ctx);
      await this.#deps.store.put({ ...stored, state: advanced, auditorPassToken: auditorToken });
      const parked = advanced.status === 'NEEDS_APPROVAL';
      return {
        state: (parked ? 'input-required' : 'completed') as TaskState,
        message: `cutover ${runId} → ${advanced.status}`,
        artifacts: [
          { name: 'pilot_run', data: runArtifact(advanced), text: JSON.stringify(runArtifact(advanced)) },
        ],
      };
    });
  }
}

export function handleRpc(
  body: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  executor: PilotExecutor,
): Promise<{ id: unknown; result?: unknown; error?: { code: number; message: string } }> {
  const id = body.id ?? null;
  const method = body.method;
  if (method !== 'message/send' && method !== 'message/stream') {
    return Promise.resolve({
      id,
      error: { code: -32601, message: `Unsupported method ${String(method)}` },
    });
  }
  const params = (body.params ?? {}) as Record<string, unknown>;
  const message = params.message as Record<string, unknown> | undefined;
  const text = extractText(message);
  const contextId =
    (typeof message?.contextId === 'string' && message.contextId) ||
    crypto.randomUUID();
  const taskId =
    (typeof message?.messageId === 'string' && message.messageId) || crypto.randomUUID();

  return executor.handle(text, headers, { taskId, contextId }).then((out) => ({
    id,
    result: makeTask({
      id: taskId,
      contextId,
      state: out.state,
      message: out.message,
      artifacts: out.artifacts,
    }),
  }));
}
