// Nightly backup: every table as JSON + uploaded photos, written to backup/.
// Uses the public (publishable) key — all backed-up tables are publicly readable via RLS.
// Run: node scripts/backup.mjs   (GitHub Actions runs it nightly; see .github/workflows/backup.yml)

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = await readFile(path.join(root, 'config.js'), 'utf8');
const URL_ = config.match(/SUPABASE_URL = '([^']+)'/)[1];
const KEY = config.match(/SUPABASE_ANON_KEY = '([^']+)'/)[1];
const OUT = path.join(root, 'backup');
const BUCKET_PREFIX = `${URL_}/storage/v1/object/public/recipe-images/`;

// table → stable sort order, so unchanged data produces an identical file (no empty commits)
const TABLES = {
  recipes: 'id',
  ratings: 'recipe_id,person',
  cook_log: 'id',
  comments: 'id',
  week_list: 'recipe_id',
};

async function fetchAll(table, order) {
  const rows = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const res = await fetch(`${URL_}/rest/v1/${table}?select=*&order=${order}&limit=${page}&offset=${from}`, {
      headers: { apikey: KEY },
    });
    if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < page) return rows;
  }
}

const exists = (p) => access(p).then(() => true, () => false);

await mkdir(path.join(OUT, 'images'), { recursive: true });
const counts = {};
let recipes = [];
for (const [table, order] of Object.entries(TABLES)) {
  const rows = await fetchAll(table, order);
  if (table === 'recipes') recipes = rows;
  counts[table] = rows.length;
  await writeFile(path.join(OUT, `${table}.json`), JSON.stringify(rows, null, 2) + '\n');
}

// Photos uploaded through the site live in our storage bucket; photos linked from recipe sites don't.
let saved = 0;
for (const r of recipes) {
  if (!r.image_url?.startsWith(BUCKET_PREFIX)) continue;
  const name = r.image_url.slice(BUCKET_PREFIX.length);
  const dest = path.join(OUT, 'images', name);
  if (await exists(dest)) continue;  // uploads are never overwritten, only added
  const res = await fetch(r.image_url);
  if (!res.ok) { console.warn(`image ${name}: ${res.status}`); continue; }
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  saved++;
}

console.log('Backed up:', Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(', '), `| new photos ${saved}`);
