const CONFIG_ENV = 'PORTER_EDGE_CONFIG_JSON';

function readConfig(): Record<string, unknown> {
  const raw = process.env[CONFIG_ENV];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new Error(`${CONFIG_ENV} must be valid JSON.`);
  }
}

export async function get<T = unknown>(key: string): Promise<T | undefined> {
  return readConfig()[key] as T | undefined;
}

export async function getAll<T extends Record<string, unknown> = Record<string, unknown>>(): Promise<T> {
  return readConfig() as T;
}
