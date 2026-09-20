import { put } from '@vercel/blob';

export async function POST() {
  await put('x.txt', 'hi', { access: 'public' });
  return Response.json({ ok: true });
}
