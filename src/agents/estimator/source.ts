import { readFile } from 'node:fs/promises';
import type { PackageJson, VercelProject } from './types.ts';

/**
 * Vercel's API does not serve source files for Git-linked projects, so package.json
 * comes from the linked GitHub repo (or a local file the user points at).
 */
export async function loadPackageJson(opts: {
  localPath?: string;
  project?: VercelProject;
  githubToken?: string;
  fetch?: typeof fetch;
}): Promise<{ pkg: PackageJson; origin: string } | { pkg: null; reason: string }> {
  if (opts.localPath) {
    try {
      return { pkg: JSON.parse(await readFile(opts.localPath, 'utf8')) as PackageJson, origin: opts.localPath };
    } catch (e) {
      return { pkg: null, reason: `Could not read ${opts.localPath}: ${(e as Error).message}` };
    }
  }

  const link = opts.project?.link;
  if (!link || link.type !== 'github' || !link.org || !link.repo) {
    return { pkg: null, reason: 'Project is not linked to a GitHub repo; pass --package-json <path>.' };
  }
  const dir = (opts.project?.rootDirectory ?? '').replace(/^\/+|\/+$/g, '');
  const path = dir ? `${dir}/package.json` : 'package.json';
  const url = new URL(`https://api.github.com/repos/${link.org}/${link.repo}/contents/${path}`);
  if (link.productionBranch) url.searchParams.set('ref', link.productionBranch);

  const res = await (opts.fetch ?? fetch)(url, {
    headers: {
      Accept: 'application/vnd.github.raw+json',
      'User-Agent': 'varsiko-estimator',
      ...(opts.githubToken ? { Authorization: `Bearer ${opts.githubToken}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    const hint = res.status === 404 && !opts.githubToken ? ' (private repo? set GITHUB_TOKEN)' : '';
    return { pkg: null, reason: `GitHub returned ${res.status} for ${link.org}/${link.repo}/${path}${hint}` };
  }
  try {
    return { pkg: (await res.json()) as PackageJson, origin: `github:${link.org}/${link.repo}/${path}` };
  } catch {
    return { pkg: null, reason: `${path} in ${link.org}/${link.repo} is not valid JSON` };
  }
}
