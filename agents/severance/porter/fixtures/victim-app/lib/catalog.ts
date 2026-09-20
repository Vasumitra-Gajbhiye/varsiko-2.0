export type Product = {
  slug: string;
  title: string;
  description: string;
  heroUrl: string;
  priceInr: number;
};

const CATALOG: Product[] = [
  { slug: 'kettle', title: 'Copper Kettle', description: 'Hand-beaten.', heroUrl: 'https://cdn.vasiko.press/kettle.jpg', priceInr: 4200 },
  { slug: 'lamp', title: 'Brass Lamp', description: 'Cast in Moradabad.', heroUrl: 'https://cdn.vasiko.press/lamp.jpg', priceInr: 7800 },
  { slug: 'tray', title: 'Enamel Tray', description: 'Six colours.', heroUrl: 'https://cdn.vasiko.press/tray.jpg', priceInr: 1900 },
];

export async function getAllSlugs(): Promise<string[]> {
  return CATALOG.map((p) => p.slug);
}

export async function getProduct(slug: string): Promise<Product | null> {
  return CATALOG.find((p) => p.slug === slug) ?? null;
}
