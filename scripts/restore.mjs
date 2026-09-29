// Restore backup/ into Supabase. Upserts by primary key: rows in the backup overwrite matching
// rows, rows added since the backup are left alone. Needs a SECRET key (bypasses RLS) — never commit it.
//
//   node scripts/restore.mjs --dry-run                       # show what would be restored
//   SUPABASE_SECRET_KEY=sb_secret_... node scripts/restore.mjs
//
// To restore an older night: git checkout <commit> -- backup/   then run this.

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = await readFile(path.join(root, 'config.js'), 'utf8');
const URL_ = config.match(/SUPABASE_URL = '([^']+)'/)[1];
const dryRun = process.argv.includes('--dry-run');
const KEY = process.env.SUPABASE_SECRET_KEY;
if (!dryRun && !KEY) {
  console.error('Set SUPABASE_SECRET_KEY (Supabase → Settings → API Keys → Secret keys), or pass --dry-run.');
  process.exit(1);
}

// recipes first: the other tables reference it
const TABLES = ['recipes', 'ratings', 'cook_log', 'comments', 'week_list'];
const headers = { apikey: KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' };

for (const table of TABLES) {
  const rows = JSON.parse(await readFile(path.join(root, 'backup', `${table}.json`), 'utf8'));
  console.log(`${table}: ${rows.length} rows`);
  if (dryRun) continue;
  for (let i = 0; i < rows.length; i += 500) {
    const res = await fetch(`${URL_}/rest/v1/${table}`, {
      method: 'POST', headers, body: JSON.stringify(rows.slice(i, i + 500)),
    });
    if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
  }
}

const images = (await readdir(path.join(root, 'backup', 'images'))).filter((f) => !f.startsWith('.'));
console.log(`photos: ${images.length}`);
if (!dryRun) {
  for (const name of images) {
    const res = await fetch(`${URL_}/storage/v1/object/recipe-images/${name}`, {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
      body: await readFile(path.join(root, 'backup', 'images', name)),
    });
    if (!res.ok) throw new Error(`photo ${name}: ${res.status} ${await res.text()}`);
  }
}
console.log(dryRun ? 'Dry run — nothing written.' : 'Restore complete.');
