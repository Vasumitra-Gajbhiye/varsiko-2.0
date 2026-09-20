import { kv } from '@vercel/kv';
export async function GET() {
  return Response.json({ n: await kv.get('n') });
}
