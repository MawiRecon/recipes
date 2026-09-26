# Recipe Tracker — Plan

A shared recipe box for Mason & Lillian. Static site on GitHub Pages, data in Supabase,
recipe ingestion through OpenClaw (Slack + a queue) so all AI parsing runs on Mason's Claude plan.

## Architecture

```
            ┌──────────── GitHub Pages (static site, public) ────────────┐
            │  tiles · detail · add/edit · filters · grocery list · cook  │
            └───────────────┬──────────────────────────────┬─────────────┘
                reads (anon)│                    writes (logged in)
                            ▼                              ▼
                 ┌──────────────── Supabase ──────────────────────┐
                 │ Postgres tables · Storage (images) · Auth       │
                 │ Edge Function `fetch-recipe` (JSON-LD fast path)│
                 └───────▲─────────────────────────────▲──────────┘
                         │ service key                 │
                ┌────────┴─────────┐                   │
  Slack #recipes│  OpenClaw (Mac)  │── polls queue ────┘
  ─────────────▶│  recipe-ingest   │   every 5 min
                │  skill (Claude)  │
                └──────────────────┘
```

- **Viewing is public** (anon read via Row Level Security). **Writing needs a login**:
  magic-link email, allowlisted to Mason + Lillian.
- **No Anthropic API key anywhere.** Structured-data parsing is plain code; anything that needs
  an AI model is handed to OpenClaw, which runs on the `claude-cli` runtime (Mason's plan).
- Caveat: OpenClaw runs locally, so AI-parsed items wait in the queue while the Mac is
  asleep/off. The site shows them as "⏳ Processing" stubs in the meantime — nothing is lost.

## Ingestion pipeline

Every entry path creates a row immediately, then gets enriched:

| Entry path | Step 1 (instant) | Step 2 |
|---|---|---|
| Slack link in `#recipes` | OpenClaw sees message, inserts row | OpenClaw fetches page → JSON-LD → else Claude extraction → updates row, replies in thread |
| Site "Add by link" | Row inserted `status=queued`, Edge Function tries JSON-LD | If JSON-LD found → `needs_review`/`complete`. Else stays `queued` for OpenClaw |
| Site "Paste text" | Row inserted `status=queued`, `raw_text` stored | OpenClaw parses with Claude on next poll |
| Slack pasted text | OpenClaw parses immediately | — |
| Site manual form | Row saved `complete` | — |

**Parse order:** `schema.org/Recipe` JSON-LD (covers ~90% of real recipe sites) → Claude
extraction from page text → fallback stub (URL + `og:title` + `og:image`, `status=stub`).

**Statuses:** `queued` → `stub` | `needs_review` | `complete`. AI-parsed recipes land in
`needs_review` so a human glances at them once.

**Slack conventions:** link alone = add to "Want to try". Optional words in the message become
tags (`chicken dinner weeknight`). OpenClaw threads a reply: ✅ added / ⚠️ saved as stub, + link.

## Data model

```sql
recipes      id, title, image_url, source_url, servings, prep_min, cook_min,
             ingredients jsonb  -- [{qty, unit, item, note, section}]
             steps jsonb        -- [text]
             tags text[], status, want_to_try bool, raw_text,
             added_by, added_on, updated_at
ratings      recipe_id, person, stars 0–5         (unique per person)
cook_log     id, recipe_id, person, made_on, note  (count + "last made" derive from this)
comments     id, recipe_id, person, body, created_at
week_list    recipe_id, servings_multiplier, added_at  (shared "this week" grocery cart)
```

Tag groups (filter chips): **protein** chicken/fish/beef/pork/vegetarian · **meal**
breakfast/lunch/dinner/side/dessert · **effort** weeknight/project · **cuisine** free-form.

## Features

**Home** — photo tiles (title, avg stars, made ×N), search box, tag filter chips, sort
(newest / top rated / most made / not made in a while), tabs for All · Want to try · Needs review.

**Recipe detail** — ingredients (servings scaler ×½ ×1 ×2), steps, source link, per-person star
ratings, "We made it 🍳" button (logs date + who), last made, comments, Edit, Add to this week,
Create grocery list.

**Grocery list** — from one recipe or the whole "this week" cart; merges duplicate items and
quantities, groups by store section, checkable, copy/share button.

**Cook mode** — big text, tap-to-check steps, screen wake lock.

**Add/Edit** — one form for manual entry and editing; image upload (defaults to the page's
photo); Link / Paste tabs feed the pipeline above.

**PWA** — installable to both phones' home screens.

**Backup** — nightly export of all tables to `backup/recipes.json` in the repo.

## Build phases

1. **Foundation** — Supabase schema + RLS + auth allowlist; static site with tiles, detail,
   filters/search, manual add/edit, image upload. Deploy to GitHub Pages.
2. **Ingestion** — `fetch-recipe` Edge Function (JSON-LD); site Link/Paste tabs; OpenClaw
   `recipe-ingest` skill + 5-min queue poll.
3. **Slack** — `#recipes` channel, OpenClaw listening there, thread replies. Lillian joins.
4. **Extras** — ratings/cook log/comments, grocery list + week cart, scaling, cook mode, PWA,
   nightly backup.

## Setup Mason has to do (can't be done by Claude)

- Create a free Supabase project and share the project URL + anon key (service key goes only
  into OpenClaw's local config, never the repo).
- Create `#recipes` in Slack, invite the OpenClaw bot, invite Lillian.
- Give Claude the two login emails for the auth allowlist.
