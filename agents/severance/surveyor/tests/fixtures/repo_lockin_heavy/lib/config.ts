import { get } from '@vercel/edge-config';
export async function flag() {
  return get('on');
}
