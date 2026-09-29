# Recipe Tracker — Plan

Recipe Rolodex — a shared recipe box for Mason & Lillian: https://mawirecon.github.io/recipes/
Static site on GitHub Pages, data in Supabase. Both of them add recipes directly on the site —
no Slack, no OpenClaw, no AI parsing, no server code.

## Architecture

```
  ┌──────────── GitHub Pages (static site, public) ────────────┐
  │  tiles · detail · add/edit · filters · grocery list         │
  │  bookmarklet capture · paste parser · ingredient parser     │
  └───────────────┬──────────────────────────────┬─────────────┘
      reads (anon)│                    writes (logged in)
                  ▼                              ▼
       ┌──────────────── Supabase ───────────────────┐
       │ Postgres tables · Storage (images) · Auth    │
       └──────────────────────────────────────────────┘
```

- **Viewing is public** (anon read via Row Level Security). **Writing needs a login**:
  magic-link email, allowlisted to Mason + Lillian (`members` table, seeded from the
  gitignored `supabase/members.local.sql`).
- All parsing runs in the browser. Most recipe sites block server-side fetches with Cloudflare
  challenges (tested 2026-09-26: fitfoodiefinds, AllRecipes, Budget Bytes, Serious Eats all 403),
  so recipes are read from the page the person already has open.

## Adding a recipe

| Path | How it works |
|---|---|
| **Save to Recipe Rolodex** bookmarklet | Reads the page's `schema.org/Recipe` JSON-LD and opens the Add form prefilled (title, photo, servings, times, ingredients, steps, suggested tags). Pages without recipe data fall back to a best guess from the page text. |
| **Paste text** tab | Splits pasted text on “Ingredients” / “Instructions” headings (or line shape) and fills the form for review. |
| **Type it in** | Manual form; also the edit screen. |
| **Save link for later** | Placeholder with just the URL (`status=stub`, shown as “Just a link” / “To fill in”). Filling in ingredients or steps marks it complete. |

Meal-kit recipes with no public recipe data (e.g. Marley Spoon) go through Paste text.

## Data model

```sql
recipes      id, title, image_url, source_url, servings, prep_min, cook_min,
             ingredients jsonb  -- [{qty, qty_max, unit, item, note} | {section}]
             steps jsonb        -- [text]
             tags text[], status, want_to_try bool, notes, added_by, added_on, updated_at
ratings      recipe_id, person, stars 0–5         (unique per person)
cook_log     id, recipe_id, person, made_on, note  (count + "last made" derive from this)
comments     id, recipe_id, person, body, created_at
week_list    recipe_id, multiplier, added_at       (shared "this week" list)
```

`raw_text`, `parse_error` and the `queued` status are left over from the dropped OpenClaw plan.

## Status

**Done**
- Tiles, search, tag filters, sort; tabs All · Want to try · To fill in.
- Recipe page: per-person star ratings, “We made it” log, ingredient scaler, comments,
  per-recipe grocery list (check off / copy / share), want-to-try toggle.
- Add/edit/delete, photo upload (resized client-side; deleted with the recipe).
- Bookmarklet import, paste parser, save-link-for-later.
- This week: “+ This week” button on any recipe; `#/week` page with per-recipe scaler and one merged
  grocery list (same items summed with unit conversion, grouped by aisle, staples last,
  checkboxes remembered per browser). Custom tags fold into the Type group.

- Cook mode (`#/cook/<id>?x=<multiplier>`): big text, tap-to-check ingredients and steps with the
  current step highlighted (remembered for the tab session), screen kept awake via Wake Lock.
- No emojis anywhere in the UI — line icons from `icons.js` instead.

- Nightly backup (GitHub Actions, `.github/workflows/backup.yml`, 09:17 UTC): every table to
  `backup/*.json` plus uploaded photos to `backup/images/`; commits only when something changed,
  so git history holds every past night. Restore with `scripts/restore.mjs` (needs a Supabase
  secret key; `--dry-run` first). Photos linked from recipe sites aren't copied.

**Skipped:** PWA / home-screen install (Mason, 2026-09-29).

**Next** — nothing queued.
