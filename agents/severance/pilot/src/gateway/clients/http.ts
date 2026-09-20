export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number;
  /**
   * True when the provider definitively rejected the request (4xx other than 429), so no
   * resource can have been created. False for 5xx, 429 and network failures, where a
   * purchase MAY have gone through. Callers must not treat the two the same.
   */
  readonly definitive: boolean;

  constructor(provider: string, status: number, detail: string) {
    super(`${provider} ${status || 'network'}: ${detail}`);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.definitive = status >= 400 && status < 500 && status !== 429;
  }
}

export interface HttpOptions {
  provider: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Bounded, token-safe JSON request. The Authorization header never appears in errors. */
export async function requestJson<T>(
  opts: HttpOptions,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const f = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(url, {
      method: init.method ?? 'GET',
      headers: { accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (e) {
    throw new ProviderError(opts.provider, 0, (e as Error).name === 'TimeoutError' ? 'timed out' : 'network error');
  }
  const text = await res.text();
  if (!res.ok) {
    // Provider error bodies can echo request data; keep only a short, printable prefix.
    const snippet = text.replace(/[^\x20-\x7E]/g, ' ').slice(0, 160);
    throw new ProviderError(opts.provider, res.status, snippet || res.statusText);
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { raw: text } as T;
  }
}
