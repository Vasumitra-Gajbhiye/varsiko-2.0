import { requestJson, ProviderError, type HttpOptions } from './http.ts';

/**
 * Coolify API client for ONE server. Endpoint shapes follow Coolify's published docs
 * (create-public-application, envs/bulk, deploy, get-deployment-by-uuid). Response field
 * names beyond those documented are read defensively.
 */
export type CoolifyDeployStatus = 'queued' | 'running' | 'success' | 'failed';

export class CoolifyClient {
  readonly #base: string;
  readonly #root: string;
  readonly #token: string;
  readonly #http: HttpOptions;

  constructor(ip: string, token: string, opts: { fetch?: typeof fetch; port?: number } = {}) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error('coolify host must be an IPv4 address');
    this.#root = `http://${ip}:${opts.port ?? 8000}`;
    this.#base = `${this.#root}/api/v1`;
    this.#token = token;
    this.#http = { provider: 'coolify', fetch: opts.fetch };
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return 'CoolifyClient { token: [redacted] }';
  }

  #h() {
    return { authorization: `Bearer ${this.#token}` };
  }

  /**
   * Ready means the AUTHENTICATED API answers, which proves cloud-init created our token,
   * not merely that Coolify's web process is up.
   */
  async ready(): Promise<boolean> {
    try {
      await requestJson(this.#http, `${this.#base}/teams/current`, { headers: this.#h() });
      return true;
    } catch (e) {
      if (e instanceof ProviderError) return false; // 401 during bootstrap, refused, timeout
      throw e;
    }
  }

  async localServerUuid(): Promise<string> {
    const list = await requestJson<{ uuid: string }[]>(this.#http, `${this.#base}/servers`, { headers: this.#h() });
    const first = Array.isArray(list) ? list[0] : undefined;
    if (!first?.uuid) throw new ProviderError('coolify', 0, 'no server registered in Coolify');
    return first.uuid;
  }

  async createProject(name: string): Promise<{ uuid: string }> {
    return requestJson(this.#http, `${this.#base}/projects`, { method: 'POST', headers: this.#h(), body: { name } });
  }

  async createApplication(a: {
    project_uuid: string;
    server_uuid: string;
    git_repository: string;
    git_branch: string;
    build_pack: string;
    ports_exposes: string;
  }): Promise<{ uuid: string }> {
    return requestJson(this.#http, `${this.#base}/applications/public`, {
      method: 'POST',
      headers: this.#h(),
      body: { ...a, environment_name: 'production', instant_deploy: false },
    });
  }

  async bulkEnvs(appUuid: string, vars: { key: string; value: string }[]): Promise<number> {
    await requestJson(this.#http, `${this.#base}/applications/${encodeURIComponent(appUuid)}/envs/bulk`, {
      method: 'PATCH',
      headers: this.#h(),
      body: { data: vars.map((v) => ({ key: v.key, value: v.value, is_preview: false })) },
    });
    return vars.length;
  }

  async deploy(appUuid: string): Promise<{ deployment_uuid: string }> {
    const r = await requestJson<
      { deployments?: { deployment_uuid: string }[] } | { deployment_uuid: string }[]
    >(this.#http, `${this.#base}/deploy?uuid=${encodeURIComponent(appUuid)}&force=false`, {
      method: 'POST',
      headers: this.#h(),
    });
    const list = Array.isArray(r) ? r : r.deployments;
    const id = list?.[0]?.deployment_uuid;
    if (!id) throw new ProviderError('coolify', 0, 'deploy response had no deployment_uuid');
    return { deployment_uuid: id };
  }

  async deploymentStatus(deploymentUuid: string): Promise<CoolifyDeployStatus> {
    const r = await requestJson<{ status?: string }>(
      this.#http,
      `${this.#base}/deployments/${encodeURIComponent(deploymentUuid)}`,
      { headers: this.#h() },
    );
    return mapDeployStatus(r.status);
  }
}

/** Coolify's status vocabulary is not enumerated in the docs; unknown values stay 'running'. */
export function mapDeployStatus(raw: string | undefined): CoolifyDeployStatus {
  const s = (raw ?? '').toLowerCase();
  if (s === 'finished' || s === 'success' || s === 'succeeded') return 'success';
  if (s.startsWith('failed') || s === 'error' || s === 'cancelled' || s === 'canceled') return 'failed';
  if (s === 'queued') return 'queued';
  return 'running';
}
