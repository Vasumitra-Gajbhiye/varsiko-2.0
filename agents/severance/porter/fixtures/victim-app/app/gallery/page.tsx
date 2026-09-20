'use client';

import { useState } from 'react';
import Image from 'next/image';
import { upload } from '@vercel/blob/client';

export default function GalleryPage() {
  const [urls, setUrls] = useState<string[]>([]);

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const blob = await upload(file.name, file, {
      access: 'public',
      handleUploadUrl: '/api/upload',
    });
    setUrls((prev) => [...prev, blob.url]);
  }

  return (
    <section>
      <h1>Gallery</h1>
      <input type="file" accept="image/*" onChange={onFile} />
      {urls.map((url) => (
        <Image key={url} src={url} alt="" width={320} height={240} />
      ))}
    </section>
  );
}
