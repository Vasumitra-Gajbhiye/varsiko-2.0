import { blobTransform } from './blob.js';
import { cronTransform } from './cron.js';
import { deployTransform } from './deploy.js';
import { imageTransform } from './image.js';
import { isrTransform } from './isr.js';
import { kvTransform } from './kv.js';
import { middlewareTransform } from './middleware.js';
import { platformTransform } from './platform.js';
import type { Transform } from './types.js';

/**
 * Order matters only where two transforms touch the same file. `deploy` runs
 * last so it can read what the others found, and `next.config` is edited by
 * `isr` and `deploy` in one shared in-memory project, then saved once.
 */
export const TRANSFORMS: Transform[] = [
  kvTransform,
  blobTransform,
  imageTransform,
  isrTransform,
  cronTransform,
  middlewareTransform,
  platformTransform,
  deployTransform,
];
