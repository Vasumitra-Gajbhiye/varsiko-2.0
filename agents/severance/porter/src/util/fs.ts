import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

/** Repo-relative path with POSIX separators, so findings are stable across OSes. */
export function rel(repoRoot: string, absolute: string): string {
  return relative(repoRoot, absolute).split(sep).join('/');
}

export function abs(repoRoot: string, relative: string): string {
  return resolve(repoRoot, relative);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function readJson<T>(path: string): Promise<T | null> {
  const text = await readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function writeText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

/** 1-indexed line number of a character offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}
