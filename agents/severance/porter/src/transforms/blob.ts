import { resolve } from 'node:path';
import type { Finding } from '../inventory/schema.js';
import { rewriteImportSpecifier } from '../util/ast.js';
import { readText, rel } from '../util/fs.js';
import { appSourceFiles, importFor, libPath, stamp, template } from './shared.js';
import type { NewFile, PortStep, Transform, TransformContext } from './types.js';

/**
 * `@vercel/blob` -> S3-compatible object storage.
 *
 * Two import specifiers, two shims, one paired protocol between them:
 *
 *   `@vercel/blob`         -> server-side put/del/list/head/copy
 *   `@vercel/blob/client`  -> browser `upload()` + route-side `handleUpload()`
 *
 * The client pair is the part that makes this transform non-trivial. Vercel's
 * direct-to-storage upload is a four-step handshake, and replacing only one
 * side of it produces a browser that asks for a token nobody mints.
 */
export const blobTransform: Transform = {
  id: 'blob',
  kind: 'blob-storage',
  summary: 'Move blob storage to S3-compatible object storage',

  claims(finding: Finding) {
    return finding.kind === 'blob-storage';
  },

  async plan(findings: Finding[], ctx: TransformContext): Promise<PortStep | null> {
    const edited: string[] = [];
    let usesClientUploads = false;

    for (const file of appSourceFiles(ctx)) {
      const clientImports = file
        .getImportDeclarations()
        .filter((d) => d.getModuleSpecifierValue() === '@vercel/blob/client');

      // `handleUpload` is imported from the /client subpath but runs on the
      // server, so it must land in its own module rather than the browser
      // bundle. Decide from the imported names, not from the file's location.
      const importsHandleUpload = clientImports.some((d) =>
        d.getNamedImports().some((n) => n.getName() === 'handleUpload'),
      );

      const rewrote = rewriteImportSpecifier(file, '@vercel/blob', importFor(ctx, file, 'storage'), {
        subpaths: {
          client: importFor(ctx, file, importsHandleUpload ? 'storage/handle-upload' : 'storage/client'),
        },
      });

      if (rewrote) {
        edited.push(rel(ctx.repoRoot, file.getFilePath()));
        if (clientImports.length > 0) usesClientUploads = true;
      }
    }

    if (edited.length === 0) return null;

    const newFiles: NewFile[] = [
      {
        path: libPath(ctx.layout, 'storage/index.ts'),
        contents: stamp(await template('storage/index.ts'), '@vercel/blob'),
      },
    ];

    newFiles.push({
      path: 'infra/bucket-policy.json',
      contents: bucketPolicy(),
    });

    if (usesClientUploads) {
      newFiles.push({ path: 'infra/bucket-cors.json', contents: bucketCors() });
      newFiles.push(
        {
          path: libPath(ctx.layout, 'storage/client.ts'),
          contents: stamp(await template('storage/client.ts'), '@vercel/blob/client (browser half)'),
        },
        {
          path: libPath(ctx.layout, 'storage/handle-upload.ts'),
          contents: stamp(
            await template('storage/handle-upload.ts'),
            '@vercel/blob/client (server half)',
          ),
        },
      );
    }

    const provider = ctx.target.objectStore;

    // Uploaded blobs now live on the S3 origin, but `next/image` only serves hosts
    // listed in `remotePatterns`. The old `*.public.blob.vercel-storage.com` entry
    // no longer matches anything, so gallery images would 400 until it is updated.
    const configPath = ctx.inventory.framework.configPath;
    const configText = configPath ? await readText(resolve(ctx.repoRoot, configPath)) : null;
    const imageCaveat =
      configText !== null && /remotePatterns/.test(configText)
        ? [
            `Add the host of \`BLOB_PUBLIC_BASE_URL\` to \`images.remotePatterns\` in ${configPath}. ` +
              'Blobs are now served from your bucket or CDN, and `next/image` refuses any host that is ' +
              'not listed. Porter cannot fill this in: the origin is a deploy-time value.',
          ]
        : [];

    return {
      id: 'blob',
      kind: 'blob-storage',
      title: 'Move blob storage to S3-compatible object storage',
      rationale:
        '`@vercel/blob` authenticates with a `BLOB_READ_WRITE_TOKEN` scoped to the Vercel ' +
        'project. Off-platform that token is never issued, so uploads, deletes and listings all ' +
        'fail at runtime. The replacement module exports the same functions with the same return ' +
        'shapes (`url`, `downloadUrl`, `pathname`), so call sites are untouched.\n\n' +
        (usesClientUploads
          ? '**This app uses direct client uploads**, which is a four-step handshake rather than ' +
            'a function call: the browser asks your route for permission, your route authorises ' +
            'and mints a credential, the browser uploads straight to storage, and storage confirms ' +
            'completion. Both halves are replaced together — a presigned S3 PUT URL, scoped to one ' +
            'key and one content length, stands in for the Vercel client token.\n\n' +
            '**One behaviour genuinely changes.** Vercel called `onUploadCompleted` from their own ' +
            'infrastructure, so it fired even if the user closed the tab. S3 cannot call your app, ' +
            'so the browser reports completion instead — and a user who closes the tab mid-upload ' +
            'will not trigger it. The callback is HMAC-signed so it cannot be forged, but if it ' +
            'does bookkeeping that must not be missed, add a reconciliation sweep over `list()`.\n\n'
          : '') +
        `Generated for a \`${provider}\` endpoint with path-style addressing, which is what ` +
        'MinIO, Hetzner and most non-AWS gateways require.',
      discharges: findings.map((f) => f.id),
      editedFiles: edited.map((p) => p.replace(ctx.repoRoot, '').replace(/^[\\/]/, '')),
      newFiles,
      deps: [
        { name: '@vercel/blob', range: null, reason: 'Replaced by the S3-backed shim.' },
        { name: '@aws-sdk/client-s3', range: '^3.700.0', reason: 'S3 protocol client.' },
        {
          name: '@aws-sdk/lib-storage',
          range: '^3.700.0',
          reason: 'Chooses single-PUT or multipart by body size, so large uploads keep working.',
        },
        ...(usesClientUploads
          ? [
              {
                name: '@aws-sdk/s3-request-presigner',
                range: '^3.700.0',
                reason: 'Signs the short-lived PUT URL the browser uploads to.',
              },
            ]
          : []),
      ],
      env: [
        {
          name: 'S3_ENDPOINT',
          example: 'https://s3.your-provider.example.com',
          required: true,
          description: 'Object storage endpoint, including scheme.',
          replaces: 'BLOB_READ_WRITE_TOKEN',
        },
        { name: 'S3_BUCKET', example: 'app-blobs', required: true, description: 'Bucket name.' },
        { name: 'S3_REGION', example: 'auto', required: false, description: 'Region, or `auto`.' },
        { name: 'S3_ACCESS_KEY_ID', example: 'CHANGE_ME', required: true, description: 'Access key.' },
        {
          name: 'S3_SECRET_ACCESS_KEY',
          example: 'CHANGE_ME',
          required: true,
          description: 'Secret key. Scope it to this one bucket.',
        },
        {
          name: 'S3_FORCE_PATH_STYLE',
          example: 'true',
          required: false,
          description: 'Leave true unless the provider supports virtual-host addressing.',
        },
        {
          name: 'BLOB_PUBLIC_BASE_URL',
          example: 'https://cdn.example.com',
          required: true,
          description:
            'Public read origin for stored objects. Vercel Blob URLs were public by default; ' +
            'on S3 this requires a public-read bucket policy or a CDN in front.',
        },
        ...(usesClientUploads
          ? [
              {
                name: 'BLOB_UPLOAD_SECRET',
                example: 'CHANGE_ME_32_BYTES_OF_RANDOM',
                required: true,
                description:
                  'HMAC key signing upload-completion callbacks so the browser cannot forge them.',
              },
            ]
          : []),
      ],
      caveats: [
        ...imageCaveat,
        'Existing blobs are not copied. Objects already in Vercel Blob keep their ' +
          '`*.public.blob.vercel-storage.com` URLs and will 404 once the project is deleted. ' +
          'Mirror them across before cutover, or keep the Vercel project alive read-only.',
        'The bucket needs a public-read policy (or a CDN) for `BLOB_PUBLIC_BASE_URL` to serve ' +
          'anything. Porter writes the policy to `infra/bucket-policy.json` but does not apply it.',
        ...(usesClientUploads
          ? [
              'CORS on the bucket must allow PUT from your app origin, or browser uploads fail ' +
                'with an opaque network error. Porter writes the CORS config to `infra/bucket-cors.json`.',
            ]
          : []),
      ],
    };
  },
};

/**
 * Public-read policy for the bucket. Vercel Blob URLs were world-readable, so
 * parity means the same here. Scoped to GetObject only: no list, no write.
 */
function bucketPolicy(): string {
  return (
    JSON.stringify(
      {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'PublicReadObjects',
            Effect: 'Allow',
            Principal: '*',
            Action: ['s3:GetObject'],
            Resource: ['arn:aws:s3:::${S3_BUCKET}/*'],
          },
        ],
      },
      null,
      2,
    ) + '\n'
  );
}

/** CORS for browser-direct PUT. Replace the origin before applying. */
function bucketCors(): string {
  return (
    JSON.stringify(
      {
        CORSRules: [
          {
            AllowedOrigins: ['https://CHANGE_ME.example.com'],
            AllowedMethods: ['PUT', 'GET', 'HEAD'],
            AllowedHeaders: ['content-type', 'x-amz-*'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
      null,
      2,
    ) + '\n'
  );
}
