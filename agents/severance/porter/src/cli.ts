#!/usr/bin/env node
import { Command } from 'commander';
import { resolve } from 'node:path';
import pc from 'picocolors';
import { scanRepo } from './inventory/scan.js';
import { summarize } from './inventory/schema.js';
import { portRepo, renderPlanMarkdown } from './runtime/port.js';
import { setLevel, log } from './util/log.js';

const program = new Command();

program
  .name('porter')
  .description('Rewrite Vercel-coupled Next.js apps into reviewable off-platform diffs.')
  .option('-v, --verbose', 'show detailed progress')
  .option('--silent', 'only print command output');

program
  .command('scan')
  .argument('<repo>', 'Next.js repository to scan')
  .option('--pretty', 'print readable summary')
  .action(async (repo: string, options: { pretty?: boolean }) => {
    configureLog();
    const inventory = await scanRepo(resolve(repo));
    if (options.pretty) {
      const summary = summarize(inventory);
      console.log(`${summary.total} findings`);
      for (const item of summary.kinds) console.log(`- ${item.kind}: ${item.count}`);
    } else {
      console.log(JSON.stringify(inventory, null, 2));
    }
  });

program
  .command('port')
  .argument('<repo>', 'Next.js repository to rewrite')
  .option('--dry-run', 'compute the plan without writing files')
  .option('--pretty', 'print a readable plan before the diff')
  .action(async (repo: string, options: { dryRun?: boolean; pretty?: boolean }) => {
    configureLog();
    const root = resolve(repo);
    log.step(`${options.dryRun ? 'Planning' : 'Porting'} ${root}`);
    const result = await portRepo(root, { dryRun: options.dryRun, writeArtifacts: true });
    log.ok(`${result.plan.steps.length} migration steps`);

    if (options.pretty) {
      console.log(renderPlanMarkdown(result.plan));
      if (result.diff) console.log('\n# Diff\n');
    }

    if (result.diff) {
      console.log(result.diff);
      log.ok(`Wrote .porter/plan.json, .porter/plan.md and .porter/porter.diff`);
    } else if (options.dryRun) {
      console.log(JSON.stringify(result.plan, null, 2));
    } else {
      console.log(pc.dim('No diff produced.'));
    }
  });

program.parseAsync().catch((error) => {
  log.fail(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function configureLog() {
  const opts = program.opts<{ verbose?: boolean; silent?: boolean }>();
  setLevel(opts.silent ? 'silent' : opts.verbose ? 'verbose' : 'normal');
}
