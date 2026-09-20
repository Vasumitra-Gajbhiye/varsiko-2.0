import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { geolocation, ipAddress } from '@vercel/functions';
import { get } from '@vercel/edge-config';

export const config = {
  runtime: 'edge',
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

const BLOCKED = new Set(['XX']);

export default async function middleware(request: NextRequest) {
  const { country = 'US', city, region } = geolocation(request);
  const ip = ipAddress(request) ?? '0.0.0.0';

  if (BLOCKED.has(country)) {
    return new NextResponse('Unavailable in your region', { status: 451 });
  }

  const maintenance = await get<boolean>('maintenance_mode');
  if (maintenance && !request.nextUrl.pathname.startsWith('/maintenance')) {
    return NextResponse.rewrite(new URL('/maintenance', request.url));
  }

  const response = NextResponse.next();
  response.headers.set('x-visitor-country', country);
  response.headers.set('x-visitor-city', city ?? 'unknown');
  response.headers.set('x-visitor-region', region ?? 'unknown');
  response.headers.set('x-visitor-ip', ip);
  return response;
}
