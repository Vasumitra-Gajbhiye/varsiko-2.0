import { Sandbox } from '@vercel/sandbox';
export async function run() {
  return Sandbox.create();
}
