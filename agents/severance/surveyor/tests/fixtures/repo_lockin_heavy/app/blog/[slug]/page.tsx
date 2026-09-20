export const revalidate = 60;

export function generateStaticParams() {
  return [{ slug: 'hello' }];
}

export default function Post() {
  return <article>post</article>;
}
