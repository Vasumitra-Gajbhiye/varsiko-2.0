import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executePorter, handleRpc } from '../src/a2a/executor.js';
import { rewriteRpc, extractText, makeTask } from '../src/a2a/compat.js';

describe('a2a compat', () => {
  it('rewrites SendMessage and ROLE_USER', () => {
    const body = rewriteRpc({
      jsonrpc: '2.0',
      method: 'SendMessage',
      params: {
        message: {
          role: 'ROLE_USER',
          parts: [{ text: 'hi' }],
        },
      },
    }) as { method: string; params: { message: { role: string; parts: { kind?: string }[] } } };
    assert.equal(body.method, 'message/send');
    assert.equal(body.params.message.role, 'user');
    assert.equal(body.params.message.parts[0]?.kind, 'text');
  });

  it('extracts text and data parts', () => {
    assert.equal(
      extractText({ parts: [{ kind: 'text', text: 'a' }, { kind: 'data', data: { x: 1 } }] }),
      'a\n{"x":1}',
    );
  });

  it('builds a Task envelope', () => {
    const task = makeTask({
      id: 't1',
      contextId: 'c1',
      state: 'completed',
      message: 'ok',
      artifacts: [{ name: 'port_plan', data: { schema: 'severance.port_plan/v1' } }],
    });
    assert.equal(task.kind, 'task');
    assert.equal((task.status as { state: string }).state, 'completed');
    assert.equal((task.artifacts as unknown[]).length, 1);
  });
});

describe('porter executor offline', () => {
  it('ports the fixture and returns a port_plan artifact', async () => {
    process.env.PORTER_OFFLINE = '1';
    delete process.env.PORTER_APPLY;
    const out = await executePorter('port this app');
    assert.equal(out.state, 'completed');
    assert.match(out.message, /PORTER_PLANNED|PORTER_NOOP/);
    const plan = out.artifacts.find((a) => a.name === 'port_plan');
    assert.ok(plan?.data);
    assert.equal((plan!.data as { schema: string }).schema, 'severance.port_plan/v1');
    const diff = out.artifacts.find((a) => a.name === 'porter_diff');
    assert.ok(diff?.text !== undefined);
  });

  it('refuses BLOCKED specs without rewriting', async () => {
    process.env.PORTER_OFFLINE = '1';
    const spec = {
      schema: 'severance.capacity_spec/v1',
      decision: { verdict: 'BLOCKED', reasons: ['UNSUPPORTED_FRAMEWORK'] },
      constraints: { ceiling_inr_monthly: 1500 },
    };
    const out = await executePorter(JSON.stringify(spec));
    assert.equal(out.state, 'completed');
    assert.match(out.message, /PORTER_REFUSED/);
    const refusal = out.artifacts.find((a) => a.name === 'porter_refusal');
    assert.equal((refusal?.data as { status: string }).status, 'refused');
  });

  it('forwards the Surveyor spec as an artifact', async () => {
    process.env.PORTER_OFFLINE = '1';
    const spec = {
      schema: 'severance.capacity_spec/v1',
      decision: { verdict: 'PROCEED_WITH_PORTER', reasons: ['lock-in'] },
      constraints: { ceiling_inr_monthly: 1500, spec_floor: { vcpu: 2, ram_gb: 4, disk_gb: 40 } },
      lockin_detail: [{ feature: '@vercel/blob', porter_hint: 'S3 shim' }],
    };
    const out = await executePorter(JSON.stringify(spec));
    assert.equal(out.state, 'completed');
    const forwarded = out.artifacts.find((a) => a.name === 'surveyor_result');
    assert.equal((forwarded?.data as { schema: string }).schema, 'severance.capacity_spec/v1');
  });

  it('handleRpc returns a Task via message/send', async () => {
    process.env.PORTER_OFFLINE = '1';
    const reply = await handleRpc(
      {
        jsonrpc: '2.0',
        id: '1',
        method: 'message/send',
        params: {
          message: {
            messageId: 'm1',
            contextId: 'c1',
            role: 'user',
            parts: [{ kind: 'text', text: 'offline port' }],
          },
        },
      },
      {},
    );
    assert.equal(reply.id, '1');
    assert.ok(reply.result);
    assert.equal((reply.result as { kind: string }).kind, 'task');
  });
});
