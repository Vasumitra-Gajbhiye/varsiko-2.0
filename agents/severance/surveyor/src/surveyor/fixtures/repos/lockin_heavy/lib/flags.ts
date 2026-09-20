import { flag } from '@vercel/flags';
import { mountVercelToolbar } from '@vercel/toolbar';
export const demo = flag({ key: 'demo' });
export function toolbar() {
  mountVercelToolbar();
}
