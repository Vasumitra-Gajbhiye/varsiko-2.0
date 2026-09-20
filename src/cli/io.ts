import { createInterface } from 'node:readline/promises';

/**
 * What every operator command talks to, so tests can capture output and answer prompts
 * without a terminal. Commands return an exit code instead of calling process.exit.
 */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** Asks a yes/no question; resolves true only for an explicit "yes". */
  confirm(question: string): Promise<boolean>;
  env: NodeJS.ProcessEnv;
}

export function processIo(): CliIo {
  return {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    env: process.env,
    async confirm(question) {
      if (!process.stdin.isTTY) return false; // never auto-approve when nobody can answer
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await rl.question(`${question} Type "yes" to continue: `)).trim().toLowerCase() === 'yes';
      } finally {
        rl.close();
      }
    },
  };
}

/** A usage mistake: printed without a stack, exit code 2. */
export class UsageError extends Error {}

/** Runs a command entry point and maps its outcome to a process exit code. */
export async function runMain(cmd: (argv: string[], io: CliIo) => Promise<number>): Promise<void> {
  // Set exitCode instead of calling process.exit(): on Windows, exiting with fetch handles still
  // closing trips a libuv assertion and turns a clean exit into a crash code.
  try {
    process.exitCode = await cmd(process.argv.slice(2), processIo());
  } catch (e) {
    // parseArgs failures (unknown flag, missing value) are usage mistakes too.
    const usage = e instanceof UsageError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = usage ? 2 : 1;
  }
}
