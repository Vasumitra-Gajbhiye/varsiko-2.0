import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BYTES = 200 * 1024 * 1024;
const USER_AGENT = 'severance-porter/0.1';

export class RepoFetchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'RepoFetchError';
  }
}

function parseGithub(repoUrl: string): { owner: string; name: string } {
  const cleaned = repoUrl.trim().replace(/\.git$/, '').replace(/\/$/, '');
  const m = cleaned.match(/github\.com[/:]([^/]+)\/([^/]+)/i);
  if (!m) throw new RepoFetchError('BAD_REPO_URL', 'expected a github.com owner/name URL');
  return { owner: m[1]!, name: m[2]! };
}

/**
 * Fetch a GitHub tarball and extract it with system tar (no git binary).
 * Same idea as Surveyor's repo_fetch.py.
 */
export async function fetchGithubTarball(
  repoUrl: string,
  opts: { ref?: string; token?: string; dest?: string } = {},
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const { owner, name } = parseGithub(repoUrl);
  const ref = opts.ref || 'HEAD';
  const url = `https://api.github.com/repos/${owner}/${name}/tarball/${ref}`;
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
  };
  const token = opts.token ?? process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers, redirect: 'follow' });
  if (res.status === 404) throw new RepoFetchError('REPO_NOT_FOUND', `GitHub tarball 404 for ${owner}/${name}`);
  if (!res.ok) throw new RepoFetchError('REPO_FETCH_FAILED', `GitHub tarball HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new RepoFetchError('REPO_TOO_LARGE', `tarball exceeded ${MAX_BYTES} bytes`);

  const dest = opts.dest ?? (await mkdtemp(join(tmpdir(), 'porter-fetch-')));
  const tarball = join(dest, '_source.tgz');
  await writeFile(tarball, buf);

  // GitHub wraps a single top-level directory; strip it.
  try {
    await execFileAsync('tar', ['-xzf', tarball, '-C', dest, '--strip-components=1'], {
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    await rm(dest, { recursive: true, force: true });
    throw new RepoFetchError(
      'UNSAFE_ARCHIVE',
      err instanceof Error ? err.message : 'tar extract failed',
    );
  } finally {
    await rm(tarball, { force: true }).catch(() => undefined);
  }

  return {
    root: dest,
    cleanup: async () => {
      await rm(dest, { recursive: true, force: true });
    },
  };
}
