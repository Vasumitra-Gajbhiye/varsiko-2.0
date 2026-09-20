import Image from 'next/image';

export function Hero({ src, alt }: { src: string; alt: string }) {
  return <Image src={src} alt={alt} fill sizes="100vw" style={{ objectFit: 'cover' }} />;
}
