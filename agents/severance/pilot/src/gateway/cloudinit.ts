import { createHash } from 'node:crypto';

/**
 * The only bootstrap Pilot may cause to run on a purchased box.
 *
 * cloud-init is arbitrary code execution by definition, so the mandate pins the SHA-256
 * of the TEMPLATE, and this module refuses to render anything else. Substitution is
 * limited to a fixed set of placeholders whose values must match a strict charset, so a
 * value can never carry shell syntax into the script.
 */
export const ALLOWED_PLACEHOLDERS = [
  'COOLIFY_ROOT_USER',
  'COOLIFY_ROOT_EMAIL',
  'COOLIFY_ROOT_PASSWORD',
  'API_TOKEN_SHA256',
  'ALLOWED_IPS',
] as const;

export type Placeholder = (typeof ALLOWED_PLACEHOLDERS)[number];

const SAFE_VALUE = /^[A-Za-z0-9@._,:/+=-]{0,200}$/;

export const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export function renderCloudInit(
  template: string,
  values: Record<Placeholder, string>,
): { userData: string; templateSha256: string } {
  const found = new Set(template.match(/__[A-Z0-9_]+__/g) ?? []);
  for (const token of found) {
    const name = token.slice(2, -2);
    if (!(ALLOWED_PLACEHOLDERS as readonly string[]).includes(name)) {
      throw new Error(`template contains a placeholder that is not whitelisted: ${token}`);
    }
  }
  let out = template;
  for (const name of ALLOWED_PLACEHOLDERS) {
    const v = values[name];
    if (typeof v !== 'string' || !SAFE_VALUE.test(v)) {
      throw new Error(`value for ${name} is missing or contains characters outside the safe set`);
    }
    out = out.split(`__${name}__`).join(v);
  }
  return { userData: out, templateSha256: sha256Hex(template) };
}
