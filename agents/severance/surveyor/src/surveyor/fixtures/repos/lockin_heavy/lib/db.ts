import { sql } from '@vercel/postgres';
export async function ping() {
  return sql`select 1`;
}
