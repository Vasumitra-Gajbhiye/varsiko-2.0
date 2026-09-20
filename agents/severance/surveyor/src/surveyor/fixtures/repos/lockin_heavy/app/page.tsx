import Image from 'next/image';
import { draftMode } from 'next/headers';

export default async function Page() {
  const dm = await draftMode();
  const url = process.env.VERCEL_URL;
  return (
    <div>
      <Image src="/x.png" alt="" width={10} height={10} />
      {url} {dm.isEnabled ? 'draft' : ''}
    </div>
  );
}
