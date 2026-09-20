import pc from 'picocolors';

export type Level = 'silent' | 'normal' | 'verbose';

let level: Level = 'normal';
export function setLevel(next: Level) {
  level = next;
}

export const log = {
  step(msg: string) {
    if (level === 'silent') return;
    process.stderr.write(`${pc.cyan('→')} ${msg}\n`);
  },
  ok(msg: string) {
    if (level === 'silent') return;
    process.stderr.write(`${pc.green('✓')} ${msg}\n`);
  },
  warn(msg: string) {
    if (level === 'silent') return;
    process.stderr.write(`${pc.yellow('!')} ${msg}\n`);
  },
  fail(msg: string) {
    process.stderr.write(`${pc.red('✗')} ${msg}\n`);
  },
  detail(msg: string) {
    if (level !== 'verbose') return;
    process.stderr.write(`  ${pc.dim(msg)}\n`);
  },
  blank() {
    if (level === 'silent') return;
    process.stderr.write('\n');
  },
};
