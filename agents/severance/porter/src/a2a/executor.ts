import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractNasikoToken, extractText, makeTask, type TaskState } from './compat.js';
import { fetchGithubTarball, RepoFetchError } from './fetch-repo.js';
import { portRepo, renderPlanMarkdown } from '../runtime/port.js';

const SCHEMA_SPEC = 'severance.capacity_spec/v1';
const SCHEMA_PORT = 'severance.port_plan/v1';

const FIXTURE = resolve(
  fileURLToPath(new URL('../..', import.meta.url)),
  'fixtures/victim-app',
);

export type CapacitySpec = {
  schema?: string;
  decision?: { verdict?: string; blockers?: string[]; reasons?: string[] };
  surveyor?: { repo?: { url?: string; ref?: string } };
  source_project?: string;
  [key: string]: unknown;
};

function looksLikeSpec(text: string): CapacitySpec | null {
  const trimmed = text.trim();
  if (!trimmed.includes(SCHEMA_SPEC) && !trimmed.includes('"schema"')) return null;
  try {
    const start = trimmed.indexOf('{');
    const blob = start >= 0 ? trimmed.slice(start) : trimmed;
    const data = JSON.parse(blob) as CapacitySpec;
    if (data?.schema === SCHEMA_SPEC || data?.decision || data?.constraints) return data;
  } catch {
    /* fall through */
  }
  return null;
}

function githubFromText(text: string): string | null {
  const m = text.match(/https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i);
  return m ? m[0]!.replace(/\.git$/, '') : null;
}

function repoFromSpec(spec: CapacitySpec): { url: string; ref?: string } | null {
  const url = spec.surveyor?.repo?.url;
  if (typeof url === 'string' && /github\.com/i.test(url)) {
    return { url, ref: spec.surveyor?.repo?.ref };
  }
  if (typeof spec.source_project === 'string' && /github\.com/i.test(spec.source_project)) {
    return { url: spec.source_project };
  }
  return null;
}

function surveyorHints(spec: CapacitySpec | null): string[] {
  const detail = (spec as { lockin_detail?: { feature?: string; porter_hint?: string }[] } | null)
    ?.lockin_detail;
  if (!Array.isArray(detail)) return [];
  return detail
    .map((d) => {
      const feature = d.feature ?? 'unknown';
      const hint = d.porter_hint ? ` — ${d.porter_hint}` : '';
      return `${feature}${hint}`;
    })
    .filter(Boolean);
}

export type ExecuteResult = {
  state: TaskState;
  message: string;
  artifacts: { name: string; text?: string; data?: unknown }[];
};

/**
 * Code decides. Dry-run by default. Offline uses fixtures/victim-app.
 */
export async function executePorter(
  inboundText: string,
  _headers: Record<string, string | string[] | undefined> = {},
): Promise<ExecuteResult> {
  const offline = process.env.PORTER_OFFLINE === '1';
  const apply = process.env.PORTER_APPLY === '1';
  const dryRun = !apply;

  const spec = looksLikeSpec(inboundText);
  const verdict = (spec?.decision?.verdict ?? '').toUpperCase();

  if (verdict === 'BLOCKED') {
    const reasons = (spec?.decision?.reasons ?? []).join('; ') || 'Surveyor blocked the migration';
    return {
      state: 'completed',
      message: `PORTER_REFUSED: ${reasons}`,
      artifacts: [
        {
          name: 'porter_refusal',
          data: { schema: SCHEMA_PORT, status: 'refused', reason: 'BLOCKED', reasons: spec?.decision?.reasons ?? [] },
        },
        ...(spec ? [{ name: 'surveyor_result', data: spec, text: JSON.stringify(spec) }] : []),
      ],
    };
  }

  let repoRoot: string;
  let cleanup: (() => Promise<void>) | null = null;

  try {
    if (offline) {
      repoRoot = FIXTURE;
    } else {
      const fromSpec = spec ? repoFromSpec(spec) : null;
      const url = fromSpec?.url ?? githubFromText(inboundText);
      if (!url) {
        return {
          state: 'input-required',
          message:
            'Need a GitHub URL or a severance.capacity_spec/v1 with surveyor.repo.url. Set PORTER_OFFLINE=1 to use fixtures/victim-app.',
          artifacts: spec ? [{ name: 'surveyor_result', data: spec, text: JSON.stringify(spec) }] : [],
        };
      }
      const fetched = await fetchGithubTarball(url, { ref: fromSpec?.ref });
      repoRoot = fetched.root;
      cleanup = fetched.cleanup;
    }

    const result = await portRepo(repoRoot, { dryRun, writeArtifacts: false });
    const hints = surveyorHints(spec);
    const portDoc = {
      schema: SCHEMA_PORT,
      status: result.plan.steps.length === 0 ? 'noop' : 'planned',
      dry_run: dryRun,
      offline,
      steps: result.plan.steps.length,
      unhandled: result.plan.unhandled.length,
      touched: result.touched,
      surveyor_hints: hints,
      note:
        'Diff is a reviewable handoff. Pilot still deploys the original git_repository until a human merges.',
      plan: result.plan,
    };

    const md = renderPlanMarkdown(result.plan);
    const narration =
      result.plan.steps.length === 0
        ? 'PORTER_NOOP: nothing to rewrite; forwarding Surveyor spec.'
        : `PORTER_PLANNED: ${result.plan.steps.length} steps, ${result.plan.unhandled.length} need a human` +
          (dryRun ? ' (dry-run)' : '');

    return {
      state: 'completed',
      message: narration,
      artifacts: [
        { name: 'port_plan', data: portDoc, text: JSON.stringify(portDoc) },
        { name: 'porter_diff', text: result.diff || '(empty diff)' },
        { name: 'plan_md', text: md },
        ...(spec ? [{ name: 'surveyor_result', data: spec, text: JSON.stringify(spec) }] : []),
      ],
    };
  } catch (err) {
    const code = err instanceof RepoFetchError ? err.code : 'PORTER_ERROR';
    const message = err instanceof Error ? err.message : String(err);
    return {
      state: 'failed',
      message: `${code}: ${message}`,
      artifacts: [
        { name: 'porter_error', data: { schema: SCHEMA_PORT, status: 'error', code, message } },
        ...(spec ? [{ name: 'surveyor_result', data: spec, text: JSON.stringify(spec) }] : []),
      ],
    };
  } finally {
    if (cleanup) await cleanup().catch(() => undefined);
  }
}

export function handleRpc(
  body: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
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
    (typeof params.session_id === 'string' && params.session_id) ||
    crypto.randomUUID();
  const taskId =
    (typeof message?.messageId === 'string' && message.messageId) || crypto.randomUUID();

  // Token is accepted for forwarding; Porter does not call MCP today.
  void extractNasikoToken(headers);

  return executePorter(text, headers).then((out) => ({
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
