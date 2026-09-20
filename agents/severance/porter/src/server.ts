import express from 'express';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { portRepo, renderPlanMarkdown } from './runtime/port.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

const agentCard = JSON.parse(
  await readFile(new URL('../AgentCard.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

app.get('/health', (_req, res) => res.json({ status: 'healthy', service: 'porter' }));
app.get('/.well-known/agent-card.json', (_req, res) => res.json(agentCard));
app.get('/AgentCard.json', (_req, res) => res.json(agentCard));

app.post('/port', async (req, res, next) => {
  try {
    const repoRoot = req.body?.repoRoot;
    if (!repoRoot || typeof repoRoot !== 'string') {
      res.status(400).json({ error: 'repoRoot is required' });
      return;
    }
    const result = await portRepo(resolve(repoRoot), {
      dryRun: Boolean(req.body?.dryRun),
      writeArtifacts: req.body?.writeArtifacts !== false,
    });
    res.json({
      plan: result.plan,
      planMarkdown: renderPlanMarkdown(result.plan),
      diff: result.diff,
      touched: result.touched,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/', async (req, res, next) => {
  try {
    const method = req.body?.method;
    if (method !== 'message/send') {
      res.status(400).json({ error: 'Unsupported method', supported: ['message/send'] });
      return;
    }
    const repoRoot = req.body?.params?.repoRoot ?? req.body?.repoRoot;
    if (!repoRoot) {
      res.status(400).json({ error: 'repoRoot is required in params' });
      return;
    }
    const result = await portRepo(resolve(String(repoRoot)), {
      dryRun: Boolean(req.body?.params?.dryRun),
      writeArtifacts: true,
    });
    res.json({
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      result: {
        content: [{ type: 'text', text: renderPlanMarkdown(result.plan) }],
        artifacts: [{ type: 'diff', text: result.diff }],
      },
    });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
});

const port = Number(process.env.PORT || 8000);
app.listen(port, '0.0.0.0', () => {
  process.stderr.write(`Porter listening on ${port}\n`);
});
