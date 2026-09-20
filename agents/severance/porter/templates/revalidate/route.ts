import { revalidatePath, revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const auth = request.headers.get('authorization');
  const legacy = request.headers.get('x-revalidate-secret');
  const bearer = process.env.REVALIDATE_SECRET ? `Bearer ${process.env.REVALIDATE_SECRET}` : null;

  if (!process.env.REVALIDATE_SECRET || (auth !== bearer && legacy !== process.env.REVALIDATE_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    path?: string;
    tag?: string;
    tags?: string[];
  };

  if (body.path) revalidatePath(body.path);
  if (body.tag) revalidateTag(body.tag);
  for (const tag of body.tags ?? []) revalidateTag(tag);

  return NextResponse.json({
    revalidated: true,
    path: body.path ?? null,
    tags: [body.tag, ...(body.tags ?? [])].filter(Boolean),
    now: Date.now(),
  });
}
