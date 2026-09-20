import type { Finding } from '../inventory/schema.js';
import type { PortStep, Transform, TransformContext } from './types.js';

/**
 * `next/image` needs no rewrite off-platform: Next.js ships its own optimizer.
 * What Vercel hid is that the optimizer wants `sharp` installed to be
 * production-grade, and that it now spends your CPU and disk instead of theirs.
 * So the change is a dependency and a set of warnings — deliberately not a
 * config edit. (An earlier revision of this transform wrote an
 * `images.customCacheHandler` key; that option does not exist in Next.js.)
 */
export const imageTransform: Transform = {
  id: 'image',
  kind: 'image-optimization',
  summary: 'Install sharp so next/image runs on the self-hosted optimizer',

  claims(finding: Finding) {
    return finding.kind === 'image-optimization';
  },

  async plan(findings: Finding[], ctx: TransformContext): Promise<PortStep | null> {
    // Next 16 tracks sharp 0.34; 14 and 15 track 0.33. A range outside the one
    // Next ships against gets installed twice, with Next using its own copy.
    const range = ctx.inventory.framework.major >= 16 ? '^0.34.4' : '^0.33.5';

    return {
      id: 'image',
      kind: 'image-optimization',
      title: 'Run next/image on the self-hosted sharp optimizer',
      rationale:
        'On Vercel, `next/image` is served by their optimizer and CDN. Self-hosted, Next.js optimizes ' +
        'in-process; `sharp` is what makes that path fast and is not guaranteed to be present in a ' +
        'container image. Porter adds it as an explicit dependency and leaves `next.config` alone — the ' +
        'image settings you already have are valid off-platform.',
      discharges: findings.map((f) => f.id),
      editedFiles: [],
      newFiles: [],
      deps: [{ name: 'sharp', range, reason: 'Production next/image optimizer.' }],
      env: [],
      caveats: [
        'Image optimization now spends CPU and memory on your own servers, and its cache is on each ' +
          "replica's local disk. Keep `remotePatterns` tight and put a CDN in front if traffic is high.",
        '`images.remotePatterns` may still list `*.public.blob.vercel-storage.com`. Keep it until existing ' +
          'blobs are migrated, then remove it.',
      ],
    };
  },
};
