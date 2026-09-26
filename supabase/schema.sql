-- Recipe Tracker schema. Paste into Supabase → SQL Editor → Run. Safe to re-run.
-- Member emails are seeded separately (members.local.sql, not committed).

create extension if not exists pgcrypto;

-- ── Members (login allowlist) ────────────────────────────────────────────────
create table if not exists public.members (
  email text primary key,
  name  text not null unique
);
alter table public.members enable row level security;  -- no policies: invisible to the API

create or replace function public.member_name() returns text
language sql stable security definer set search_path = public as $$
  select name from members where email = lower(auth.jwt() ->> 'email')
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select public.member_name() is not null
$$;

-- Lets the login form refuse unknown emails before sending a magic link.
create or replace function public.is_allowed_email(e text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where email = lower(trim(e)))
$$;

-- ── Recipes ─────────────────────────────────────────────────────────────────
create table if not exists public.recipes (
  id           uuid primary key default gen_random_uuid(),
  title        text not null default 'Untitled recipe',
  notes        text,
  image_url    text,
  source_url   text,
  servings     numeric,
  prep_min     int,
  cook_min     int,
  ingredients  jsonb not null default '[]',  -- [{qty, qty_max, unit, item, note} | {section}]
  steps        jsonb not null default '[]',  -- ["step text", ...]
  tags         text[] not null default '{}',
  status       text not null default 'complete'
               check (status in ('queued', 'stub', 'needs_review', 'complete')),
  want_to_try  boolean not null default false,
  raw_text     text,       -- pasted text waiting for OpenClaw
  parse_error  text,
  added_by     text default public.member_name(),
  added_on     timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

drop trigger if exists recipes_touch on public.recipes;
create trigger recipes_touch before update on public.recipes
  for each row execute function public.touch_updated_at();

create table if not exists public.ratings (
  recipe_id  uuid not null references public.recipes on delete cascade,
  person     text not null default public.member_name(),
  stars      int  not null check (stars between 0 and 5),
  updated_at timestamptz not null default now(),
  primary key (recipe_id, person)
);

create table if not exists public.cook_log (
  id         uuid primary key default gen_random_uuid(),
  recipe_id  uuid not null references public.recipes on delete cascade,
  person     text default public.member_name(),
  made_on    date not null default current_date,
  note       text,
  created_at timestamptz not null default now()
);

create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  recipe_id  uuid not null references public.recipes on delete cascade,
  person     text default public.member_name(),
  body       text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.week_list (
  recipe_id  uuid primary key references public.recipes on delete cascade,
  multiplier numeric not null default 1,
  added_at   timestamptz not null default now()
);

create or replace view public.recipe_stats with (security_invoker = true) as
select r.id as recipe_id,
       (select round(avg(stars)::numeric, 1) from public.ratings  where recipe_id = r.id) as avg_stars,
       (select count(*)                      from public.cook_log where recipe_id = r.id) as made_count,
       (select max(made_on)                  from public.cook_log where recipe_id = r.id) as last_made
from public.recipes r;

-- ── Row Level Security: anyone reads, members write ─────────────────────────
do $$
declare t text;
begin
  foreach t in array array['recipes', 'ratings', 'cook_log', 'comments', 'week_list'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('drop policy if exists "members write" on public.%I', t);
    execute format('create policy "public read" on public.%I for select using (true)', t);
    execute format('create policy "members write" on public.%I for all to authenticated
                    using (public.is_member()) with check (public.is_member())', t);
  end loop;
end $$;

grant usage on schema public to anon, authenticated;
grant select on public.recipes, public.ratings, public.cook_log, public.comments,
                public.week_list, public.recipe_stats to anon, authenticated;
grant insert, update, delete on public.recipes, public.ratings, public.cook_log,
                public.comments, public.week_list to authenticated;
grant execute on function public.member_name(), public.is_member(),
                public.is_allowed_email(text) to anon, authenticated;

-- ── Image storage: public bucket, members upload ────────────────────────────
insert into storage.buckets (id, name, public)
values ('recipe-images', 'recipe-images', true)
on conflict (id) do nothing;

drop policy if exists "members upload images" on storage.objects;
drop policy if exists "members update images" on storage.objects;
drop policy if exists "members delete images" on storage.objects;
create policy "members upload images" on storage.objects for insert to authenticated
  with check (bucket_id = 'recipe-images' and public.is_member());
create policy "members update images" on storage.objects for update to authenticated
  using (bucket_id = 'recipe-images' and public.is_member());
create policy "members delete images" on storage.objects for delete to authenticated
  using (bucket_id = 'recipe-images' and public.is_member());
