/**
 * Server half of the client-upload protocol — the replacement for
 * `handleUpload()` from `@vercel/blob/client`.
 *
 * Written by Porter (Severance agent 03).
 *
 * The signature matches Vercel's, including `onBeforeGenerateToken` and
 * `onUploadCompleted`, so the route handler that calls it does not change
 * shape. What changes underneath: instead of minting a Vercel client token,
 * this signs an S3 PUT URL scoped to exactly one key, one content type and one
 * content length, expiring in minutes.
 *
 * SECURITY NOTE, and the reason `onBeforeGenerateToken` is not optional here:
 * a presigned PUT is a capability. Anyone holding the URL can write that
 * object until it expires. The authorisation check in `onBeforeGenerateToken`
 * is the only thing standing between an anonymous visitor and your bucket, so
 * this implementation **throws if it is not supplied**, where Vercel's merely
 * warned.
 */

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { s3, urlForKey, normalizePathname } from './index';

export type HandleUploadBody =
  | {
      type: 'porter.generate-upload-url';
      payload: {
        pathname: string;
        contentType: string;
        contentLength: number;
        clientPayload: string | null;
        multipart: boolean;
      };
    }
  | {
      type: 'porter.upload-completed';
      payload: {
        completionToken: string;
        blob: { url: string; pathname: string; contentType: string };
        clientPayload: string | null;
      };
    };

export type GenerateTokenOptions = {
  allowedContentTypes?: string[];
  maximumSizeInBytes?: number;
  /** Seconds the presigned URL stays valid. Default 600. */
  validUntil?: number;
  tokenPayload?: string;
  addRandomSuffix?: boolean;
};

export type HandleUploadOptions = {
  body: HandleUploadBody;
  request: Request;
  onBeforeGenerateToken: (
    pathname: string,
    clientPayload: string | null,
  ) => Promise<GenerateTokenOptions>;
  onUploadCompleted?: (event: {
    blob: { url: string; pathname: string; contentType: string };
    tokenPayload: string | null;
  }) => Promise<void>;
};

const DEFAULT_EXPIRY_SECONDS = 600;
const MAX_DEFAULT_SIZE = 50 * 1024 * 1024;

function secret(): string {
  const value = process.env.BLOB_UPLOAD_SECRET;
  if (!value) {
    throw new Error(
      'Missing BLOB_UPLOAD_SECRET. Porter uses it to sign upload-completion ' +
        'callbacks so the browser cannot forge them. See .env.porter.example.',
    );
  }
  return value;
}

/**
 * The completion callback comes from the browser, which means it is attacker
 * controlled. Signing the key at grant time and verifying on completion stops
 * a client claiming an upload it never made.
 */
function signCompletion(key: string, tokenPayload: string | null): string {
  return createHmac('sha256', secret())
    .update(`${key}\n${tokenPayload ?? ''}`)
    .digest('hex');
}

function verifyCompletion(token: string, key: string, tokenPayload: string | null): boolean {
  const expected = signCompletion(key, tokenPayload);
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function withRandomSuffix(pathname: string): string {
  const suffix = randomBytes(6).toString('hex');
  const dot = pathname.lastIndexOf('.');
  const slash = pathname.lastIndexOf('/');
  if (dot > slash && dot !== -1) {
    return `${pathname.slice(0, dot)}-${suffix}${pathname.slice(dot)}`;
  }
  return `${pathname}-${suffix}`;
}

export async function handleUpload(options: HandleUploadOptions): Promise<unknown> {
  const { body } = options;

  if (typeof options.onBeforeGenerateToken !== 'function') {
    throw new Error(
      'onBeforeGenerateToken is required. A presigned upload URL is a write ' +
        'capability for your bucket; without an authorisation check, anyone can take one.',
    );
  }

  if (body.type === 'porter.generate-upload-url') {
    const { pathname, contentType, contentLength, clientPayload } = body.payload;
    const rules = await options.onBeforeGenerateToken(pathname, clientPayload);

    if (rules.allowedContentTypes && !rules.allowedContentTypes.includes(contentType)) {
      throw new Error(`Content type ${contentType} is not allowed for ${pathname}.`);
    }

    const maxBytes = rules.maximumSizeInBytes ?? MAX_DEFAULT_SIZE;
    if (contentLength > maxBytes) {
      throw new Error(`Upload is ${contentLength} bytes; the limit is ${maxBytes}.`);
    }

    let key = normalizePathname(pathname);
    if (rules.addRandomSuffix) key = withRandomSuffix(key);

    // ContentLength is signed into the URL, so the browser cannot present a
    // small file to pass the check and then upload a large one.
    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
      CacheControl: 'public, max-age=31536000, immutable',
    });

    const uploadUrl = await getSignedUrl(s3(), command, {
      expiresIn: rules.validUntil ?? DEFAULT_EXPIRY_SECONDS,
    });

    const url = urlForKey(key);
    return {
      type: 'porter.presigned-upload',
      uploadUrl,
      requiredHeaders: {
        'content-type': contentType,
      },
      blob: {
        url,
        downloadUrl: `${url}?download=1`,
        pathname: key,
        contentType,
        contentDisposition: `inline; filename="${key.split('/').pop() ?? key}"`,
      },
      completionToken: signCompletion(key, rules.tokenPayload ?? null),
    };
  }

  if (body.type === 'porter.upload-completed') {
    const { completionToken, blob, clientPayload } = body.payload;

    if (!verifyCompletion(completionToken, blob.pathname, clientPayload)) {
      throw new Error('Upload completion signature did not verify.');
    }

    await options.onUploadCompleted?.({ blob, tokenPayload: clientPayload });
    return { type: 'porter.upload-completed', response: 'ok' };
  }

  throw new Error(`Unrecognised upload request type.`);
}
