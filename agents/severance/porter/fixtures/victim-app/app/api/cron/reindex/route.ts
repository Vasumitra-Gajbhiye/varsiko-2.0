import { NextResponse } from 'next/server';
import { getAllSlugs } from '@/lib/catalog';

export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  const slugs = await getAllSlugs();
  return NextResponse.json({ reindexed: slugs.length });
}
