import type { CliIo } from '../../src/cli/io.ts';

/** A CliIo that records output and answers prompts from a script. */
export function captureIo(opts: { env?: NodeJS.ProcessEnv; confirm?: boolean } = {}) {
  const lines: string[] = [];
  const prompts: string[] = [];
  const io: CliIo = {
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    env: opts.env ?? {},
    async confirm(q) {
      prompts.push(q);
      return opts.confirm ?? false;
    },
  };
  return { io, lines, prompts, text: () => lines.join('\n') };
}
