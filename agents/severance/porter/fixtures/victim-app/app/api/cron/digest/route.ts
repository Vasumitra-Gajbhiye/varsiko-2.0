import { NextResponse } from 'next/server';
import { topProducts } from '@/lib/rate-limit';

export const maxDuration = 60;

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const top = await topProducts(5);
  console.log('sending daily digest', top);
  return NextResponse.json({ sent: true, top });
}
