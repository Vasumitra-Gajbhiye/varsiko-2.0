import { NextResponse } from 'next/server';
import { geolocation } from '@vercel/functions';
import type { NextRequest } from 'next/server';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  const geo = geolocation(request);
  return NextResponse.json(geo);
}
