import { put, del, list, head } from '@vercel/blob';

export async function uploadAsset(pathname: string, body: File | Blob | ArrayBuffer) {
  const blob = await put(pathname, body, {
    access: 'public',
    addRandomSuffix: true,
    cacheControlMaxAge: 31536000,
  });
  return { url: blob.url, downloadUrl: blob.downloadUrl, pathname: blob.pathname };
}

export async function removeAsset(url: string) {
  await del(url);
}

export async function listAssets(prefix: string) {
  const { blobs } = await list({ prefix, limit: 100 });
  return blobs.map((b) => ({ url: b.url, pathname: b.pathname, size: b.size }));
}

export async function assetExists(url: string) {
  try {
    await head(url);
    return true;
  } catch {
    return false;
  }
}
