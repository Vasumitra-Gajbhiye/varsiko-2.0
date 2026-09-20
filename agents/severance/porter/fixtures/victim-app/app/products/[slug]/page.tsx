import Image from 'next/image';
import { notFound } from 'next/navigation';
import { trackView } from '@/lib/rate-limit';
import { getProduct, getAllSlugs } from '@/lib/catalog';

export const revalidate = 600;
export const dynamicParams = true;

export async function generateStaticParams() {
  const slugs = await getAllSlugs();
  return slugs.map((slug) => ({ slug }));
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = await getProduct(slug);
  if (!product) notFound();

  await trackView(slug);

  return (
    <article>
      <h1>{product.title}</h1>
      <Image
        src={product.heroUrl}
        alt={product.title}
        width={1200}
        height={630}
        priority
        sizes="(max-width: 768px) 100vw, 1200px"
      />
      <p>{product.description}</p>
      <p>{new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(product.priceInr)}</p>
    </article>
  );
}
