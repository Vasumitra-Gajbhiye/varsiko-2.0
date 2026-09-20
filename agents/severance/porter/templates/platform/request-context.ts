import type { NextRequest } from 'next/server';

export type Geo = {
  city?: string;
  country?: string;
  flag?: string;
  countryRegion?: string;
  region?: string;
  latitude?: string;
  longitude?: string;
};

function header(request: Request | NextRequest, name: string): string | undefined {
  return request.headers.get(name) ?? undefined;
}

export function geolocation(request: Request | NextRequest): Geo {
  return {
    city: header(request, 'x-geo-city') ?? header(request, 'cf-ipcity'),
    country:
      header(request, 'x-geo-country') ??
      header(request, 'cf-ipcountry') ??
      header(request, 'x-vercel-ip-country'),
    countryRegion:
      header(request, 'x-geo-region') ??
      header(request, 'cf-region') ??
      header(request, 'x-vercel-ip-country-region'),
    region:
      header(request, 'x-geo-region') ??
      header(request, 'cf-region') ??
      header(request, 'x-vercel-ip-country-region'),
    latitude: header(request, 'x-geo-latitude') ?? header(request, 'x-vercel-ip-latitude'),
    longitude: header(request, 'x-geo-longitude') ?? header(request, 'x-vercel-ip-longitude'),
  };
}

export function ipAddress(request: Request | NextRequest): string | undefined {
  const forwarded = header(request, 'x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim();
  return (
    header(request, 'x-real-ip') ??
    header(request, 'cf-connecting-ip') ??
    header(request, 'x-vercel-forwarded-for')
  );
}
