# Recipe Box

Shared recipe tracker for Mason & Lillian. Static site (GitHub Pages) + Supabase.
See [PLAN.md](PLAN.md) for architecture and roadmap.

- `index.html`, `styles.css`, `app.js` — the site (no build step)
- `ingredients.js` — ingredient line parser / formatter / scaler
- `config.js` — Supabase URL + publishable key, people, tag groups
- `supabase/schema.sql` — tables, RLS, storage bucket (safe to re-run)
