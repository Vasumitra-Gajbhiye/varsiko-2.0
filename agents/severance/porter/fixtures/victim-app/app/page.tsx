import Image from 'next/image';
import Link from 'next/link';
import { getAllSlugs, getProduct } from '@/lib/catalog';

export const revalidate = 3600;

export default async function Home() {
  const slugs = await getAllSlugs();
  const products = await Promise.all(slugs.map((s) => getProduct(s)));

  return (
    <main>
      <h1>Vasiko Press</h1>
      <ul>
        {products.map((p) =>
          p ? (
            <li key={p.slug}>
              <Link href={`/products/${p.slug}`}>
                <Image src={p.heroUrl} alt={p.title} width={400} height={300} />
                <span>{p.title}</span>
              </Link>
            </li>
          ) : null,
        )}
      </ul>
    </main>
  );
}
