const key = process.env.AI_GATEWAY_API_KEY;
export const model = 'openai/gpt-4.1';
export function gateway() {
  return key;
}
