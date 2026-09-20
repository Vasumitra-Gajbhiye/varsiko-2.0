import express from 'express';
import { readFile } from 'node:fs/promises';
import { rewriteRpc } from './a2a/compat.js';
import { handleRpc } from './a2a/executor.js';

const app = express();
app.use(express.json({ limit: '4mb' }));

const agentCard = JSON.parse(
  await readFile(new URL('../AgentCard.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

app.get('/health', (_req, res) => res.json({ status: 'healthy', service: 'severance-porter' }));
app.get('/.well-known/agent-card.json', (_req, res) => res.json(agentCard));
app.get('/.well-known/agent.json', (_req, res) => res.json(agentCard));
app.get('/AgentCard.json', (_req, res) => res.json(agentCard));

app.post('/', async (req, res) => {
  try {
    const body = rewriteRpc(req.body) as Record<string, unknown>;
    const reply = await handleRpc(body, req.headers as Record<string, string | string[] | undefined>);
    if (reply.error) {
      res.status(200).json({ jsonrpc: '2.0', id: reply.id, error: reply.error });
      return;
    }
    res.status(200).json({ jsonrpc: '2.0', id: reply.id, result: reply.result });
  } catch (error) {
    res.status(500).json({
      jsonrpc: '2.0',
      id: (req.body as { id?: unknown })?.id ?? null,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    });
  }
});

// Local-dev alias kept for CLI muscle memory; prefers dry-run.
app.post('/port', async (req, res) => {
  try {
    const repoRoot = req.body?.repoRoot;
    if (!repoRoot || typeof repoRoot !== 'string') {
      res.status(400).json({ error: 'repoRoot is required (or use A2A message/send)' });
      return;
    }
    const { portRepo, renderPlanMarkdown } = await import('./runtime/port.js');
    const result = await portRepo(repoRoot, {
      dryRun: req.body?.dryRun !== false,
      writeArtifacts: req.body?.writeArtifacts !== false,
    });
    res.json({
      plan: result.plan,
      planMarkdown: renderPlanMarkdown(result.plan),
      diff: result.diff,
      touched: result.touched,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const port = Number(process.env.PORT || 8000);
app.listen(port, '0.0.0.0', () => {
  process.stderr.write(`severance-porter listening on ${port}\n`);
});
