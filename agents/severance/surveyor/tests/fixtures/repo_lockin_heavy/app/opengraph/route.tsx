import { ImageResponse } from 'next/og';
export function GET() {
  return new ImageResponse(<div>hi</div>, { width: 10, height: 10 });
}
