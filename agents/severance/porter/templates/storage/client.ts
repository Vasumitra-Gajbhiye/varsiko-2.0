/**
 * Drop-in replacement for `@vercel/blob/client`.
 *
 * Written by Porter (Severance agent 03).
 *
 * HOW THE ORIGINAL WORKED, AND WHY THIS IS NOT A ONE-LINE SWAP
 *
 * `@vercel/blob/client` is a two-sided protocol, not a function:
 *
 *   1. The browser calls `upload()`, which POSTs to your own route
 *      (`handleUploadUrl`) asking for permission to upload.
 *   2. Your route calls `handleUpload()`, which runs your
 *      `onBeforeGenerateToken` authorisation check and mints a short-lived
 *      client token.
 *   3. The browser uploads **directly** to blob storage with that token, so the
 *      file never passes through your server.
 *   4. Blob storage calls your route back to tell it the upload finished.
 *
 * Both halves have to be replaced together or neither works. This file is the
 * browser half; `handle-upload.ts` is the server half. They speak a protocol
 * of their own — the same *shape* as Vercel's, with a presigned S3 PUT URL
 * standing in for the client token.
 *
 * Step 4 changes meaningfully and the pull request says so out loud: Vercel
 * called your `onUploadCompleted` from their infrastructure, so it fired even
 * if the user closed the tab. S3 cannot call your app. Here the browser
 * reports completion instead, which means **a user who closes the tab
 * mid-upload will not trigger the callback**. If `onUploadCompleted` does
 * something that must not be missed, reconcile with a `list()` sweep.
 */

export type PutBlobResult = {
  url: string;
  downloadUrl: string;
  pathname: string;
  contentType: string;
  contentDisposition: string;
};

export type UploadOptions = {
  access: 'public';
  handleUploadUrl: string;
  contentType?: string;
  clientPayload?: string;
  multipart?: boolean;
  onUploadProgress?: (progress: {
    loaded: number;
    total: number;
    percentage: number;
  }) => void;
  abortSignal?: AbortSignal;
};

export class BlobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobError';
  }
}

type GrantResponse = {
  type: 'porter.presigned-upload';
  uploadUrl: string;
  requiredHeaders: Record<string, string>;
  blob: PutBlobResult;
  completionToken: string;
};

/**
 * Upload a file straight from the browser to object storage.
 *
 * Signature matches `@vercel/blob/client`'s `upload()`, so call sites are
 * unchanged.
 */
export async function upload(
  pathname: string,
  body: File | Blob,
  options: UploadOptions,
): Promise<PutBlobResult> {
  if (options.access !== 'public') {
    throw new BlobError("Only access: 'public' is supported, matching @vercel/blob.");
  }

  // --- 1. ask our own server for permission + a presigned URL ---
  const grantResponse = await fetch(options.handleUploadUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'porter.generate-upload-url',
      payload: {
        pathname,
        contentType: options.contentType || body.type || 'application/octet-stream',
        contentLength: body.size,
        clientPayload: options.clientPayload ?? null,
        multipart: options.multipart ?? false,
      },
    }),
    signal: options.abortSignal ?? null,
  });

  if (!grantResponse.ok) {
    const detail = await grantResponse.text().catch(() => '');
    throw new BlobError(`Upload was refused (${grantResponse.status}): ${detail}`);
  }

  const grant = (await grantResponse.json()) as GrantResponse;

  // --- 2. PUT the bytes straight to storage ---
  await putWithProgress(grant.uploadUrl, body, grant.requiredHeaders, options);

  // --- 3. tell our server the upload landed ---
  // Best-effort: the bytes are already stored, so a failure here must not fail
  // the upload from the caller's point of view.
  try {
    await fetch(options.handleUploadUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'porter.upload-completed',
        payload: {
          completionToken: grant.completionToken,
          blob: grant.blob,
          clientPayload: options.clientPayload ?? null,
        },
      }),
    });
  } catch {
    // Swallowed on purpose. See the note about reconciliation at the top.
  }

  return grant.blob;
}

/**
 * `fetch` cannot report upload progress, so when the caller asked for progress
 * we fall back to XMLHttpRequest. When they did not, `fetch` is the better
 * path: it honours AbortSignal cleanly and streams.
 */
function putWithProgress(
  uploadUrl: string,
  body: File | Blob,
  headers: Record<string, string>,
  options: UploadOptions,
): Promise<void> {
  if (!options.onUploadProgress) {
    return fetch(uploadUrl, {
      method: 'PUT',
      body,
      headers,
      signal: options.abortSignal ?? null,
    }).then((response) => {
      if (!response.ok) {
        throw new BlobError(`Storage rejected the upload (${response.status}).`);
      }
    });
  }

  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', uploadUrl);
    for (const [key, value] of Object.entries(headers)) {
      request.setRequestHeader(key, value);
    }

    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      options.onUploadProgress?.({
        loaded: event.loaded,
        total: event.total,
        percentage: Math.round((event.loaded / event.total) * 100),
      });
    });

    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new BlobError(`Storage rejected the upload (${request.status}).`));
    });
    request.addEventListener('error', () => reject(new BlobError('Upload failed.')));
    request.addEventListener('abort', () => reject(new BlobError('Upload aborted.')));

    options.abortSignal?.addEventListener('abort', () => request.abort());
    request.send(body);
  });
}
