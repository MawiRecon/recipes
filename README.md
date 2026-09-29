# Recipe Rolodex

Shared recipe tracker for Mason & Lillian. Static site (GitHub Pages) + Supabase.
See [PLAN.md](PLAN.md) for architecture and roadmap.

- `index.html`, `styles.css`, `app.js` — the site (no build step)
- `ingredients.js` — ingredient line parser / formatter / scaler
- `import.js` — Save to Recipe Rolodex bookmarklet + schema.org Recipe import
- `paste.js` — pasted-text recipe parser
- `grocery.js` — merged, aisle-grouped grocery list
- `icons.js` — inline line icons (no emojis in the UI)
- `config.js` — Supabase URL + publishable key, people, tag groups
- `supabase/schema.sql` — tables, RLS, storage bucket (safe to re-run)
- `scripts/backup.mjs` — nightly backup to `backup/` (run by `.github/workflows/backup.yml`)
- `scripts/restore.mjs` — restore `backup/` into Supabase (`--dry-run` first; needs a secret key)
