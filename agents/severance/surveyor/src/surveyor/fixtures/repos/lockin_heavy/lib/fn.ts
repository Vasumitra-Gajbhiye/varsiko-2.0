import { waitUntil } from '@vercel/functions';
export function work() {
  waitUntil(Promise.resolve());
}
