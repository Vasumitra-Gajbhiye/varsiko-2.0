/**
 * Drop-in replacement for `@vercel/blob`, backed by any S3-compatible store.
 *
 * Written by Porter (Severance agent 03). The exported names and their return
 * shapes match `@vercel/blob` so that the migration is an import rewrite rather
 * than a call-site rewrite — that is what keeps the diff reviewable.
 *
 * Deliberate differences from Vercel Blob, all of which are called out in the
 * pull request body rather than hidden here:
 *
 *   - `access` only accepts 'public'. Vercel Blob is public-only too, so this
 *     is parity, but on S3 "public" is a property of the bucket policy, not of
 *     the object. Porter emits the bucket policy alongside this file.
 *   - `downloadUrl` is the same URL with `?download=1`. Vercel serves a
 *     distinct attachment URL; on S3 the query flag is ignored, so the object is
 *     served inline. Forcing a download needs a presigned GET carrying
 *     response-content-disposition, or a rule on the CDN in front of the bucket.
 *   - `list()` pagination uses S3 continuation tokens, surfaced through the same
 *     `cursor` / `hasMore` fields.
 *
 * Env:
 *   S3_ENDPOINT            https://s3.eu-central-1.example.com
 *   S3_REGION              auto | eu-central-1 | ...
 *   S3_BUCKET              app-blobs
 *   S3_ACCESS_KEY_ID
 *   S3_SECRET_ACCESS_KEY
 *   S3_FORCE_PATH_STYLE    "true" for MinIO and most non-AWS providers
 *   BLOB_PUBLIC_BASE_URL   https://cdn.example.com  (public read origin)
 */

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  CopyObjectCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { randomBytes } from 'node:crypto';

export type PutBlobResult = {
  url: string;
  downloadUrl: string;
  pathname: string;
  contentType: string;
  contentDisposition: string;
};

export type HeadBlobResult = PutBlobResult & {
  size: number;
  uploadedAt: Date;
  cacheControl: string;
};

export type ListBlobResultBlob = {
  url: string;
  downloadUrl: string;
  pathname: string;
  size: number;
  uploadedAt: Date;
};

export type ListBlobResult = {
  blobs: ListBlobResultBlob[];
  cursor?: string;
  hasMore: boolean;
};

export type PutCommandOptions = {
  access?: 'public';
  addRandomSuffix?: boolean;
  contentType?: string;
  cacheControlMaxAge?: number;
  /** Accepted and ignored: the S3 SDK streams large bodies automatically. */
  multipart?: boolean;
  token?: string;
};

export class BlobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobError';
  }
}

export class BlobNotFoundError extends BlobError {
  constructor(pathname: string) {
    super(`Blob not found: ${pathname}`);
    this.name = 'BlobNotFoundError';
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new BlobError(
      `Missing ${name}. Porter replaced @vercel/blob with S3-compatible storage; ` +
        `see .env.porter.example for the full set of variables this app now needs.`,
    );
  }
  return value;
}

let cached: S3Client | undefined;

export function s3(): S3Client {
  if (cached) return cached;
  const config: S3ClientConfig = {
    region: process.env.S3_REGION || 'auto',
    endpoint: requireEnv('S3_ENDPOINT'),
    // MinIO, Hetzner and most self-hosted gateways cannot do virtual-host
    // addressing without wildcard DNS, so path style is the safe default.
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    credentials: {
      accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
    },
  };
  cached = new S3Client(config);
  return cached;
}

function bucket(): string {
  return requireEnv('S3_BUCKET');
}

function publicBase(): string {
  return requireEnv('BLOB_PUBLIC_BASE_URL').replace(/\/+$/, '');
}

/** Vercel Blob prepends no slash and collapses duplicates. Match that. */
export function normalizePathname(pathname: string): string {
  return pathname.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
}

/**
 * Vercel appends a random suffix before the extension when `addRandomSuffix`
 * is set, so two uploads of `logo.png` do not collide. Same shape here.
 */
function withRandomSuffix(pathname: string): string {
  const suffix = randomBytes(8).toString('hex').slice(0, 12);
  const dot = pathname.lastIndexOf('.');
  const slash = pathname.lastIndexOf('/');
  if (dot > slash && dot !== -1) {
    return `${pathname.slice(0, dot)}-${suffix}${pathname.slice(dot)}`;
  }
  return `${pathname}-${suffix}`;
}

export function urlForKey(key: string): string {
  return `${publicBase()}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/** The inverse of `urlForKey`, tolerant of full URLs and bare pathnames. */
export function keyFromUrl(urlOrPathname: string): string {
  if (!/^https?:\/\//.test(urlOrPathname)) return normalizePathname(urlOrPathname);
  const base = publicBase();
  const withoutBase = urlOrPathname.startsWith(base)
    ? urlOrPathname.slice(base.length)
    : new URL(urlOrPathname).pathname;
  return decodeURIComponent(normalizePathname(withoutBase.split('?')[0] ?? ''));
}

function guessContentType(pathname: string, explicit?: string): string {
  if (explicit) return explicit;
  const ext = pathname.slice(pathname.lastIndexOf('.') + 1).toLowerCase();
  const table: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    avif: 'image/avif',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    json: 'application/json',
    txt: 'text/plain',
    csv: 'text/csv',
    mp4: 'video/mp4',
    webm: 'video/webm',
  };
  return table[ext] ?? 'application/octet-stream';
}

type PutBody =
  | string
  | Buffer
  | Uint8Array
  | ArrayBuffer
  | Blob
  | ReadableStream
  | NodeJS.ReadableStream;

async function toUploadable(body: PutBody): Promise<Buffer | NodeJS.ReadableStream> {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }
  // Web ReadableStream and Node Readable both flow through lib-storage as-is.
  return body as NodeJS.ReadableStream;
}

export async function put(
  pathname: string,
  body: PutBody,
  options: PutCommandOptions = {},
): Promise<PutBlobResult> {
  if (options.access && options.access !== 'public') {
    throw new BlobError("Only access: 'public' is supported, matching @vercel/blob.");
  }

  let key = normalizePathname(pathname);
  if (options.addRandomSuffix) key = withRandomSuffix(key);

  const contentType = guessContentType(key, options.contentType);
  const cacheControl = `public, max-age=${options.cacheControlMaxAge ?? 31536000}, immutable`;
  const payload = await toUploadable(body);

  // lib-storage handles both single PUT and multipart, picking per body size.
  // Doing it unconditionally means large uploads that worked on Vercel Blob
  // keep working here without the call site knowing anything changed.
  const upload = new Upload({
    client: s3(),
    params: {
      Bucket: bucket(),
      Key: key,
      Body: payload as never,
      ContentType: contentType,
      CacheControl: cacheControl,
    },
  });
  await upload.done();

  const url = urlForKey(key);
  return {
    url,
    downloadUrl: `${url}?download=1`,
    pathname: key,
    contentType,
    contentDisposition: `inline; filename="${key.split('/').pop() ?? key}"`,
  };
}

export async function del(urlOrUrls: string | string[]): Promise<void> {
  const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
  if (urls.length === 0) return;

  if (urls.length === 1) {
    await s3().send(
      new DeleteObjectCommand({ Bucket: bucket(), Key: keyFromUrl(urls[0] as string) }),
    );
    return;
  }

  // S3 caps batch deletes at 1000 keys per request.
  for (let i = 0; i < urls.length; i += 1000) {
    const slice = urls.slice(i, i + 1000);
    await s3().send(
      new DeleteObjectsCommand({
        Bucket: bucket(),
        Delete: { Objects: slice.map((u) => ({ Key: keyFromUrl(u) })) },
      }),
    );
  }
}

export async function list(
  options: { prefix?: string; limit?: number; cursor?: string } = {},
): Promise<ListBlobResult> {
  const response = await s3().send(
    new ListObjectsV2Command({
      Bucket: bucket(),
      Prefix: options.prefix ? normalizePathname(options.prefix) : undefined,
      MaxKeys: options.limit ?? 1000,
      ContinuationToken: options.cursor,
    }),
  );

  const blobs = (response.Contents ?? []).map((object) => {
    const key = object.Key ?? '';
    const url = urlForKey(key);
    return {
      url,
      downloadUrl: `${url}?download=1`,
      pathname: key,
      size: object.Size ?? 0,
      uploadedAt: object.LastModified ?? new Date(0),
    };
  });

  return {
    blobs,
    cursor: response.NextContinuationToken,
    hasMore: Boolean(response.IsTruncated),
  };
}

export async function head(url: string): Promise<HeadBlobResult> {
  const key = keyFromUrl(url);
  try {
    const response = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    const publicUrl = urlForKey(key);
    return {
      url: publicUrl,
      downloadUrl: `${publicUrl}?download=1`,
      pathname: key,
      size: response.ContentLength ?? 0,
      uploadedAt: response.LastModified ?? new Date(0),
      contentType: response.ContentType ?? 'application/octet-stream',
      contentDisposition: response.ContentDisposition ?? `inline; filename="${key}"`,
      cacheControl: response.CacheControl ?? '',
    };
  } catch (error) {
    // @vercel/blob throws BlobNotFoundError on a missing key, and call sites
    // commonly catch it by name. Preserve that so `catch` blocks keep working.
    const name = (error as { name?: string }).name;
    if (name === 'NotFound' || name === 'NoSuchKey') throw new BlobNotFoundError(key);
    throw error;
  }
}

export async function copy(
  fromUrl: string,
  toPathname: string,
  options: PutCommandOptions = {},
): Promise<PutBlobResult> {
  const sourceKey = keyFromUrl(fromUrl);
  let key = normalizePathname(toPathname);
  if (options.addRandomSuffix) key = withRandomSuffix(key);

  await s3().send(
    new CopyObjectCommand({
      Bucket: bucket(),
      Key: key,
      CopySource: `${bucket()}/${sourceKey}`,
      MetadataDirective: 'COPY',
    }),
  );

  const url = urlForKey(key);
  return {
    url,
    downloadUrl: `${url}?download=1`,
    pathname: key,
    contentType: guessContentType(key, options.contentType),
    contentDisposition: `inline; filename="${key.split('/').pop() ?? key}"`,
  };
}

/** Unused by the shim, exported because @vercel/blob exports it. */
export { PutObjectCommand as __PutObjectCommand };
