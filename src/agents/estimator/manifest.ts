import type { PackageJson, VercelProject, WorkloadProfile, WorkloadSignal } from './types.ts';

/**
 * Heuristic memory costs (MB) for dependencies known to be heavy at runtime.
 * These are rules of thumb, not measurements: tune them as real numbers come in.
 */
interface Rule {
  id: string;
  packages: string[];
  addsMemoryMb: number;
  cpuHeavy: boolean;
  note: string;
}

const RULES: Rule[] = [
  {
    id: 'prisma',
    packages: ['@prisma/client', 'prisma'],
    addsMemoryMb: 150,
    cpuHeavy: false,
    note: 'Prisma query engine binary is loaded per instance and adds to bundle size.',
  },
  {
    id: 'image-processing',
    packages: ['sharp', '@napi-rs/canvas', 'canvas', 'jimp'],
    addsMemoryMb: 300,
    cpuHeavy: true,
    note: 'Image processing is CPU and memory bound.',
  },
  {
    id: 'headless-browser',
    packages: ['puppeteer', 'puppeteer-core', 'playwright', 'playwright-core', '@sparticuz/chromium'],
    addsMemoryMb: 1500,
    cpuHeavy: true,
    note: 'Headless Chromium needs roughly 1.5 GB or more and a lot of CPU.',
  },
  {
    id: 'media-transcoding',
    packages: ['fluent-ffmpeg', '@ffmpeg-installer/ffmpeg', 'ffmpeg-static'],
    addsMemoryMb: 500,
    cpuHeavy: true,
    note: 'FFmpeg workloads are CPU bound.',
  },
  {
    id: 'ml-inference',
    packages: ['onnxruntime-node', '@tensorflow/tfjs-node', '@xenova/transformers', '@huggingface/transformers'],
    addsMemoryMb: 1200,
    cpuHeavy: true,
    note: 'In-process model inference is memory and CPU heavy.',
  },
  {
    id: 'pdf-generation',
    packages: ['pdfkit', 'pdf-lib', '@react-pdf/renderer', 'jspdf'],
    addsMemoryMb: 200,
    cpuHeavy: false,
    note: 'PDF generation buffers whole documents in memory.',
  },
  {
    id: 'spreadsheet-parsing',
    packages: ['xlsx', 'exceljs'],
    addsMemoryMb: 250,
    cpuHeavy: false,
    note: 'Spreadsheet libraries hold entire workbooks in memory.',
  },
];

const IO_BOUND_PACKAGES = ['ai', 'openai', '@anthropic-ai/sdk', '@google/generative-ai', '@ai-sdk/openai'];

/** Baseline Node process + framework runtime, before any extra dependencies. */
const FRAMEWORK_BASELINE_MB: Record<string, number> = {
  nextjs: 512,
  nuxtjs: 448,
  remix: 384,
  'react-router': 384,
  sveltekit: 320,
  astro: 320,
  'tanstack-start': 384,
  nestjs: 384,
  express: 256,
  fastify: 256,
  hono: 192,
};
const DEFAULT_BASELINE_MB = 256;

function detectFramework(pkg: PackageJson, project?: VercelProject): { name: string | null; major: number | null } {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const fromDeps: [string, string][] = [
    ['nextjs', 'next'],
    ['nuxtjs', 'nuxt'],
    ['remix', '@remix-run/node'],
    ['react-router', '@react-router/node'],
    ['sveltekit', '@sveltejs/kit'],
    ['astro', 'astro'],
    ['nestjs', '@nestjs/core'],
    ['hono', 'hono'],
    ['fastify', 'fastify'],
    ['express', 'express'],
  ];
  const name = project?.framework ?? fromDeps.find(([, dep]) => dep in deps)?.[0] ?? null;
  const depName = fromDeps.find(([n]) => n === name)?.[1];
  const range = depName ? deps[depName] : undefined;
  const major = range ? Number(/\d+/.exec(range)?.[0]) || null : null;
  return { name, major };
}

export function analyzeManifest(pkg: PackageJson, project?: VercelProject): WorkloadProfile {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const { name: framework, major } = detectFramework(pkg, project);
  const baselineMemoryMb = (framework && FRAMEWORK_BASELINE_MB[framework]) || DEFAULT_BASELINE_MB;

  const signals: WorkloadSignal[] = [];
  for (const rule of RULES) {
    const hit = rule.packages.find((p) => p in deps);
    if (hit) {
      signals.push({
        id: rule.id,
        evidence: hit,
        addsMemoryMb: rule.addsMemoryMb,
        cpuHeavy: rule.cpuHeavy,
        note: rule.note,
      });
    }
  }
  const ioHit = IO_BOUND_PACKAGES.find((p) => p in deps);
  if (ioHit) {
    signals.push({
      id: 'io-bound-ai',
      evidence: ioHit,
      addsMemoryMb: 0,
      cpuHeavy: false,
      note: 'Long-running streaming/LLM calls are I/O bound: memory is billed while waiting, CPU is not.',
    });
  }

  const buildNotes: string[] = [];
  const scripts = Object.values(pkg.scripts ?? {}).join(' ; ');
  const usesPrisma = signals.some((s) => s.id === 'prisma');
  if (usesPrisma) {
    const generates = /prisma generate/.test(scripts) || /prisma generate/.test(project?.buildCommand ?? '');
    if (!generates) {
      buildNotes.push(
        'Prisma is a dependency but no `prisma generate` was found in package.json scripts or the project build command. ' +
          'Vercel caches dependencies, so add it to `postinstall` or `build` to avoid a stale client.',
      );
    }
    buildNotes.push('Prisma client generation adds build time and CPU; consider an Enhanced or Turbo build machine if builds are slow.');
  }
  if (framework === 'nextjs') {
    buildNotes.push(
      'Whether Next.js pages are SSR or static cannot be read from package.json; the estimator uses the invocations-per-edge-request ratio from billing data instead.',
    );
  }

  const estimatedPeakMemoryMb = baselineMemoryMb + signals.reduce((sum, s) => sum + s.addsMemoryMb, 0);
  return {
    framework,
    frameworkMajor: major,
    baselineMemoryMb,
    signals,
    estimatedPeakMemoryMb,
    cpuHeavy: signals.some((s) => s.cpuHeavy),
    buildNotes,
  };
}
