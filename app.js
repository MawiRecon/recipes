import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, PEOPLE, PERSON_COLORS, TAG_GROUPS } from './config.js';
import { parseIngredients, formatIngredient } from './ingredients.js';
import { bookmarkletHref, fromCapture } from './import.js';
import { parsePasted } from './paste.js';
import { buildGroceryList, groceryText } from './grocery.js';
import { icon } from './icons.js';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $app = document.getElementById('app');
const $auth = document.getElementById('auth');
const $modal = document.getElementById('modal');

const state = {
  me: null,            // member name when logged in as Mason/Lillian
  recipes: [],
  stats: {},           // recipe_id → {avg_stars, made_count, last_made}
  week: [],            // [{recipe_id, multiplier, added_at}] — the shared "this week" list
  filters: new Set(),
  q: '',
  tab: 'all',
  sort: 'newest',
};

// ── Helpers ────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (d) => d ? new Date(d.length === 10 ? d + 'T12:00' : d)
  .toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const PENDING = ['queued', 'stub', 'needs_review'];

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
}

function fail(error, what = 'Something went wrong') {
  console.error(error);
  toast(`${what}: ${error?.message ?? error}`);
}

function starsHtml(value, editable = false) {
  let out = `<span class="stars${editable ? ' editable' : ''}">`;
  for (let i = 1; i <= 5; i++)
    out += `<button class="star${value >= i ? ' on' : ''}" data-star="${i}" ${editable ? '' : 'tabindex="-1"'} aria-label="${i} star">${icon('star')}</button>`;
  return out + '</span>';
}

// ── Auth ───────────────────────────────────────────────────────────────────
async function refreshMe() {
  const { data: { session } } = await sb.auth.getSession();
  state.me = null;
  if (session) {
    const { data } = await sb.rpc('member_name');
    state.me = data ?? null;
  }
  renderAuth(session);
}

function renderAuth(session) {
  if (state.me) {
    $auth.innerHTML = `${avatar(state.me)} <button class="ghost" id="logout">Log out</button>`;
    $auth.querySelector('#logout').onclick = async () => { await sb.auth.signOut(); await refreshMe(); route(); };
  } else if (session) {
    $auth.innerHTML = `<span class="muted">Not on the list</span> <button class="ghost" id="logout">Log out</button>`;
    $auth.querySelector('#logout').onclick = async () => { await sb.auth.signOut(); await refreshMe(); route(); };
  } else {
    $auth.innerHTML = `<button id="login">Log in</button>`;
    $auth.querySelector('#login').onclick = openLogin;
  }
}

function openLogin() {
  $modal.innerHTML = `
    <form method="dialog" id="login-form">
      <h2>Log in</h2>
      <p class="muted">We'll email you a magic link — no password.</p>
      <input type="email" name="email" placeholder="you@gmail.com" required autocomplete="email">
      <div class="modal-actions">
        <button value="cancel" formnovalidate>Cancel</button>
        <button class="primary" value="send">Send link</button>
      </div>
    </form>`;
  $modal.showModal();
  $modal.querySelector('#login-form').onsubmit = async (e) => {
    if (e.submitter?.value !== 'send') return;
    e.preventDefault();
    const email = new FormData(e.target).get('email').trim().toLowerCase();
    const { data: ok } = await sb.rpc('is_allowed_email', { e: email });
    if (!ok) return toast("That email isn't on the list");
    const { error } = await sb.auth.signInWithOtp({
      email, options: { emailRedirectTo: location.origin + location.pathname },
    });
    if (error) return fail(error, 'Could not send link');
    $modal.close();
    toast('Check your email for the link');
  };
}

// ── Data ───────────────────────────────────────────────────────────────────
async function loadRecipes() {
  const [r, s, w] = await Promise.all([
    sb.from('recipes').select('*').order('added_on', { ascending: false }),
    sb.from('recipe_stats').select('*'),
    sb.from('week_list').select('*').order('added_at'),
  ]);
  if (r.error) throw r.error;
  state.recipes = r.data;
  state.week = w.data ?? [];
  state.stats = Object.fromEntries((s.data ?? []).map((x) => [x.recipe_id, x]));
}

// Default tag groups, with every custom tag used on a recipe added to Type.
function tagGroups() {
  const known = new Set(Object.values(TAG_GROUPS).flat());
  const custom = [...new Set(state.recipes.flatMap((r) => r.tags))].filter((t) => !known.has(t)).sort();
  return Object.entries(TAG_GROUPS).map(([g, tags]) => [g, g === 'Type' ? [...tags, ...custom] : tags]);
}

const chipClass = (t) => {
  const g = tagGroups().find(([, tags]) => tags.includes(t))?.[0] ?? 'Type';
  return `chip g-${g.toLowerCase()}`;
};

const avatar = (person) => person
  ? `<span class="avatar" style="--c: var(--${PERSON_COLORS[person] ?? 'lavender'})" title="${esc(person)}">${esc(person[0])}</span>` : '';

// ── Router ─────────────────────────────────────────────────────────────────
async function route() {
  const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
  const [view, id] = path.split('/');
  const params = new URLSearchParams(query ?? '');
  window.scrollTo(0, 0);
  releaseWakeLock();
  try {
    if (view === 'r' && id) return await renderDetail(id);
    if (view === 'week') return await renderWeek();
    if (view === 'cook' && id) return await renderCook(id, +(params.get('x') ?? 1) || 1);
    if ((view === 'new' || view === 'edit') && !state.recipes.length) await loadRecipes();  // for tag chips
    if (view === 'new') return renderForm(null, params.get('import'));
    if (view === 'edit' && id) return renderForm(await getRecipe(id));
    await renderHome();
  } catch (e) {
    $app.innerHTML = `<div class="empty">Couldn't load: ${esc(e.message)}</div>`;
    console.error(e);
  }
}

async function getRecipe(id) {
  const { data, error } = await sb.from('recipes').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

// ── Home ───────────────────────────────────────────────────────────────────
async function renderHome() {
  await loadRecipes();
  const counts = {
    all: state.recipes.length,
    want: state.recipes.filter((r) => r.want_to_try).length,
    review: state.recipes.filter((r) => PENDING.includes(r.status)).length,
  };
  const used = new Set(state.recipes.flatMap((r) => r.tags));
  const groups = tagGroups()
    .map(([g, tags]) => [g, tags.filter((t) => used.has(t))])
    .filter(([, tags]) => tags.length);

  $app.innerHTML = `
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search recipes, ingredients, tags…" value="${esc(state.q)}">
      <select id="sort">
        <option value="newest">Newest</option>
        <option value="rating">Top rated</option>
        <option value="made">Most made</option>
        <option value="stale">Not made in a while</option>
        <option value="az">A–Z</option>
      </select>
      <a class="btn" href="#/week">${icon('cart')} This week${state.week.length ? ` (${state.week.length})` : ''}</a>
      ${state.me ? `<a class="btn primary" href="#/new">${icon('plus')} Add recipe</a>` : ''}
    </div>
    <div class="tabs">
      ${[['all', 'All'], ['want', 'Want to try'], ['review', 'To fill in']].map(([k, label]) =>
        `<button class="tab${state.tab === k ? ' active' : ''}" data-tab="${k}">${label} <span class="count">${counts[k]}</span></button>`).join('')}
    </div>
    ${groups.length ? `<details class="filters" ${state.filters.size ? 'open' : ''}>
      <summary>Filters${state.filters.size ? ` (${state.filters.size})` : ''}</summary>
      ${groups.map(([g, tags]) => `<div class="chip-group"><span class="group-label">${g}</span>
        ${tags.map((t) => `<button class="${chipClass(t)}${state.filters.has(t) ? ' on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}
      </div>`).join('')}
    </details>` : ''}
    <div class="grid" id="grid"></div>`;

  $app.querySelector('#sort').value = state.sort;
  $app.querySelector('#q').oninput = (e) => { state.q = e.target.value; renderGrid(); };
  $app.querySelector('#sort').onchange = (e) => { state.sort = e.target.value; renderGrid(); };
  $app.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => {
    state.tab = b.dataset.tab;
    $app.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
    renderGrid();
  });
  $app.querySelectorAll('[data-tag]').forEach((b) => b.onclick = () => {
    const t = b.dataset.tag;
    state.filters.has(t) ? state.filters.delete(t) : state.filters.add(t);
    b.classList.toggle('on');
    $app.querySelector('.filters summary').textContent = `Filters${state.filters.size ? ` (${state.filters.size})` : ''}`;
    renderGrid();
  });
  renderGrid();
}

function visibleRecipes() {
  const q = state.q.trim().toLowerCase();
  let list = state.recipes.filter((r) => {
    if (state.tab === 'want' && !r.want_to_try) return false;
    if (state.tab === 'review' && !PENDING.includes(r.status)) return false;
    for (const t of state.filters) if (!r.tags.includes(t)) return false;
    if (q) {
      const hay = [r.title, r.tags.join(' '), r.notes, ...r.ingredients.map((i) => i.item ?? '')]
        .join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const st = (r) => state.stats[r.id] ?? {};
  const sorters = {
    newest: (a, b) => b.added_on.localeCompare(a.added_on),
    rating: (a, b) => (st(b).avg_stars ?? -1) - (st(a).avg_stars ?? -1),
    made: (a, b) => (st(b).made_count ?? 0) - (st(a).made_count ?? 0),
    // made-before recipes, oldest last-made first; never-made at the end
    stale: (a, b) => (st(a).last_made ?? '9999').localeCompare(st(b).last_made ?? '9999'),
    az: (a, b) => a.title.localeCompare(b.title),
  };
  return list.sort(sorters[state.sort]);
}

function renderGrid() {
  const list = visibleRecipes();
  const $grid = document.getElementById('grid');
  if (!list.length) {
    $grid.outerHTML = `<div class="grid" id="grid"></div><div class="empty" id="empty-msg">${
      state.recipes.length ? 'No recipes match.' : 'No recipes yet — add the first one!'}</div>`;
    return;
  }
  document.getElementById('empty-msg')?.remove();
  $grid.innerHTML = list.map((r) => {
    const s = state.stats[r.id] ?? {};
    const badge = ['queued', 'stub'].includes(r.status) ? '<span class="badge warn">Just a link</span>'
      : PENDING.includes(r.status) ? '<span class="badge warn">Needs review</span>'
      : r.want_to_try ? '<span class="badge">Want to try</span>' : '';
    const meta = [
      s.avg_stars != null ? `<span class="stars-inline">${icon('star', 'filled')}</span> ${s.avg_stars}` : null,
      s.made_count ? `made ${s.made_count}×` : null,
    ].filter(Boolean).join(' · ') || (r.source_url ? esc(hostOf(r.source_url)) : '&nbsp;');
    return `<a class="tile" href="#/r/${r.id}">
      <div class="img">${r.image_url ? `<img src="${esc(r.image_url)}" alt="" loading="lazy">` : `<div class="placeholder">${icon('utensils')}</div>`}</div>
      ${badge}
      <div class="tile-body"><h3>${esc(r.title)}</h3><div class="tile-meta">${meta}</div></div>
    </a>`;
  }).join('');
}

// ── Detail ─────────────────────────────────────────────────────────────────
async function renderDetail(id) {
  const [recipe, ratings, log, comments, weekRow] = await Promise.all([
    getRecipe(id),
    sb.from('ratings').select('*').eq('recipe_id', id).then((r) => r.data ?? []),
    sb.from('cook_log').select('*').eq('recipe_id', id).order('made_on', { ascending: false }).then((r) => r.data ?? []),
    sb.from('comments').select('*').eq('recipe_id', id).order('created_at').then((r) => r.data ?? []),
    sb.from('week_list').select('*').eq('recipe_id', id).maybeSingle().then((r) => r.data),
  ]);
  let mult = 1;
  const r = recipe;
  const byPerson = Object.fromEntries(ratings.map((x) => [x.person, x.stars]));
  const time = [r.prep_min && `Prep ${r.prep_min} min`, r.cook_min && `Cook ${r.cook_min} min`].filter(Boolean);

  const ingredientsHtml = () => r.ingredients.length
    ? `<ul class="ingredients">${r.ingredients.map((i) => i.section
        ? `<li class="section">${esc(i.section)}</li>`
        : `<li>${esc(formatIngredient(i, mult))}</li>`).join('')}</ul>`
    : '<p class="muted">No ingredients yet.</p>';

  const statusBanner = ['queued', 'stub'].includes(r.status)
    ? `<div class="banner">Just a link so far — open the source and fill it in with Edit.</div>`
    : r.status === 'needs_review' ? `<div class="banner">Imported automatically — give it a once-over, then mark it reviewed. ${state.me ? `<button id="mark-reviewed">${icon('check')} Looks good</button>` : ''}</div>`
    : '';

  $app.innerHTML = `
    <article class="detail">
      <p><a class="back" href="#/">${icon('arrowLeft')} All recipes</a></p>
      ${r.image_url ? `<div class="hero"><img src="${esc(r.image_url)}" alt=""></div>` : ''}
      ${statusBanner}
      <h1>${esc(r.title)}</h1>
      <div class="meta-row">
        <span>Added ${fmtDate(r.added_on)}${r.added_by ? ` by ${esc(r.added_by)}` : ''}</span>
        ${r.servings ? `<span>Serves ${esc(r.servings)}</span>` : ''}
        ${time.map((t) => `<span>${t}</span>`).join('')}
        ${r.source_url ? `<a href="${esc(r.source_url)}" target="_blank" rel="noopener">${esc(hostOf(r.source_url))} ${icon('external')}</a>` : ''}
      </div>
      ${r.tags.length ? `<div class="chip-group">${r.tags.map((t) => `<span class="${chipClass(t)}">${esc(t)}</span>`).join('')}</div>` : ''}
      ${r.notes ? `<p>${esc(r.notes)}</p>` : ''}
      <div class="actions">
        <a class="btn" id="cook" href="#/cook/${r.id}">${icon('flame')} Cook mode</a>
        <button id="grocery">${icon('cart')} Grocery list</button>
        ${state.me ? `<button id="week">${weekRow ? `${icon('check')} This week${+weekRow.multiplier !== 1 ? ` (${fmtMult(weekRow.multiplier)})` : ''}` : `${icon('plus')} This week`}</button>
          <a class="btn" href="#/edit/${r.id}">${icon('pencil')} Edit</a>
          <button id="want">${r.want_to_try ? `${icon('bookmark', 'filled')} On want-to-try` : `${icon('bookmark')} Want to try`}</button>` : ''}
      </div>

      <section class="card">
        <h2>Ratings</h2>
        ${PEOPLE.map((p) => `<div class="rating-row" data-person="${esc(p)}">
          <span class="who">${avatar(p)} ${esc(p)}</span>
          ${starsHtml(byPerson[p] ?? 0, state.me === p)}
          <span class="muted">${byPerson[p] != null ? `${byPerson[p]}/5` : 'not rated'}</span>
        </div>`).join('')}
        ${state.me ? '<p class="hint">Tap your stars. Tap the same star again for 0.</p>' : ''}
      </section>

      <section class="card">
        <div class="made">
          <span class="made-count">${log.length}×</span>
          <span class="muted">${log.length ? `made · last ${fmtDate(log[0].made_on)}` : 'not made yet'}</span>
          ${state.me ? `<button class="primary" id="made">${icon('pot')} We made it</button>` : ''}
        </div>
        ${log.length ? `<details class="log"><summary>History</summary><ul>${log.map((l) =>
          `<li>${fmtDate(l.made_on)}${l.person ? ` — ${esc(l.person)}` : ''}${l.note ? `: ${esc(l.note)}` : ''}
          ${state.me ? `<button class="ghost danger" data-unlog="${l.id}" title="Remove">${icon('x')}</button>` : ''}</li>`).join('')}</ul></details>` : ''}
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Ingredients</h2>
          <span class="scaler">${[0.5, 1, 2, 3].map((m) =>
            `<button data-mult="${m}" class="${m === 1 ? 'on' : ''}">${m === 0.5 ? '½' : m}×</button>`).join('')}</span>
        </div>
        <div id="ingredients">${ingredientsHtml()}</div>
      </section>

      <section class="card">
        <h2>Steps</h2>
        ${r.steps.length ? `<ol class="steps">${r.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`
          : '<p class="muted">No steps yet.</p>'}
      </section>

      <section class="card">
        <h2>Comments</h2>
        ${comments.map((c) => `<div class="comment">
          <div class="by"><span>${avatar(c.person)} ${esc(c.person ?? '')} · ${fmtDate(c.created_at)}</span>
          ${state.me === c.person ? `<button class="ghost danger" data-del-comment="${c.id}">Delete</button>` : ''}</div>
          <p>${esc(c.body)}</p></div>`).join('') || '<p class="muted">No comments yet.</p>'}
        ${state.me ? `<form id="comment-form">
          <textarea name="body" placeholder="Tweaks, notes, what to do differently…" style="min-height:70px" required></textarea>
          <div class="modal-actions"><button class="primary">Post</button></div></form>` : ''}
      </section>
    </article>`;

  const reload = () => renderDetail(id);

  $app.querySelectorAll('[data-mult]').forEach((b) => b.onclick = () => {
    mult = +b.dataset.mult;
    $app.querySelectorAll('[data-mult]').forEach((x) => x.classList.toggle('on', x === b));
    document.getElementById('ingredients').innerHTML = ingredientsHtml();
    $app.querySelector('#cook').href = `#/cook/${id}${mult !== 1 ? `?x=${mult}` : ''}`;
  });

  $app.querySelector('#grocery').onclick = () => openGrocery([{ recipe: r, mult }]);


  $app.querySelector('#week')?.addEventListener('click', async () => {
    const { error } = weekRow
      ? await sb.from('week_list').delete().eq('recipe_id', id)
      : await sb.from('week_list').insert({ recipe_id: id, multiplier: mult });
    if (error) return fail(error);
    toast(weekRow ? 'Removed from this week' : `Added to this week${mult !== 1 ? ` (${fmtMult(mult)})` : ''}`);
    reload();
  });

  $app.querySelector('#mark-reviewed')?.addEventListener('click', async () => {
    const { error } = await sb.from('recipes').update({ status: 'complete' }).eq('id', id);
    error ? fail(error) : reload();
  });

  $app.querySelector('#want')?.addEventListener('click', async () => {
    const { error } = await sb.from('recipes').update({ want_to_try: !r.want_to_try }).eq('id', id);
    error ? fail(error) : reload();
  });

  if (state.me) {
    $app.querySelectorAll(`.rating-row[data-person="${CSS.escape(state.me)}"] .star`).forEach((b) => b.onclick = async () => {
      const n = +b.dataset.star;
      const stars = byPerson[state.me] === n ? 0 : n;
      const { error } = await sb.from('ratings')
        .upsert({ recipe_id: id, person: state.me, stars, updated_at: new Date().toISOString() });
      error ? fail(error) : reload();
    });
  }

  $app.querySelector('#made')?.addEventListener('click', async () => {
    const { error } = await sb.from('cook_log').insert({ recipe_id: id, person: state.me });
    if (error) return fail(error);
    if (r.want_to_try) await sb.from('recipes').update({ want_to_try: false }).eq('id', id);
    toast('Logged');
    reload();
  });

  $app.querySelectorAll('[data-unlog]').forEach((b) => b.onclick = async () => {
    if (!confirm('Remove this entry?')) return;
    const { error } = await sb.from('cook_log').delete().eq('id', b.dataset.unlog);
    error ? fail(error) : reload();
  });

  $app.querySelector('#comment-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = new FormData(e.target).get('body').trim();
    if (!body) return;
    const { error } = await sb.from('comments').insert({ recipe_id: id, person: state.me, body });
    error ? fail(error) : reload();
  });

  $app.querySelectorAll('[data-del-comment]').forEach((b) => b.onclick = async () => {
    if (!confirm('Delete this comment?')) return;
    const { error } = await sb.from('comments').delete().eq('id', b.dataset.delComment);
    error ? fail(error) : reload();
  });
}

// ── Grocery list ───────────────────────────────────────────────────────────
const fmtMult = (m) => (+m === 0.5 ? '½' : +m) + '×';

// Checked-off items live in this browser only (a per-shopper convenience).
const CHECKED_KEY = 'week-checked';
function loadChecked() {
  try { return new Set(JSON.parse(localStorage.getItem(CHECKED_KEY) ?? '[]')); } catch { return new Set(); }
}
function saveChecked(set) {
  try { localStorage.setItem(CHECKED_KEY, JSON.stringify([...set])); } catch { /* private mode */ }
}

function groceryHtml(groups, checked = new Set(), showSources = false) {
  if (!groups.length) return '<p class="muted">No ingredients yet.</p>';
  return `<div class="grocery">${groups.map(({ section, items }) => `
    <h3 class="aisle">${esc(section)}</h3>
    ${items.map((i) => `<label><input type="checkbox" data-key="${esc(i.key)}" ${checked.has(i.key) ? 'checked' : ''}>
      <span>${esc(i.label)}${showSources && i.sources.length > 1 ? ` <small class="muted">· ${i.sources.map(esc).join(', ')}</small>` : ''}</span></label>`).join('')}
  `).join('')}</div>`;
}

function wireGroceryButtons(root, text) {
  root.querySelector('.g-copy').onclick = async () => {
    await navigator.clipboard.writeText(text);
    toast('Copied — paste into Notes or Reminders');
  };
  root.querySelector('.g-share')?.addEventListener('click', () =>
    navigator.share({ title: 'Grocery list', text }).catch(() => {}));
}

function openGrocery(entries) {
  const groups = buildGroceryList(entries);
  const title = entries[0].recipe.title;
  $modal.innerHTML = `
    <h2>${esc(title)}</h2>
    ${groceryHtml(groups)}
    <div class="modal-actions">
      <button id="g-close">Close</button>
      ${navigator.share ? '<button class="g-share">Share</button>' : ''}
      <button class="primary g-copy">Copy list</button>
    </div>`;
  $modal.showModal();
  $modal.querySelector('#g-close').onclick = () => $modal.close();
  wireGroceryButtons($modal, groceryText(`Groceries — ${title}`, groups));
}

// ── This week ──────────────────────────────────────────────────────────────
async function renderWeek() {
  await loadRecipes();
  const byId = Object.fromEntries(state.recipes.map((r) => [r.id, r]));
  const entries = state.week.filter((w) => byId[w.recipe_id])
    .map((w) => ({ recipe: byId[w.recipe_id], mult: +w.multiplier }));
  const groups = buildGroceryList(entries);
  const checked = loadChecked();
  const itemCount = groups.reduce((n, g) => n + g.items.length, 0);

  $app.innerHTML = `
    <div class="detail">
      <p><a class="back" href="#/">${icon('arrowLeft')} All recipes</a></p>
      <h1>This week</h1>
      ${entries.length ? `
        <section class="card week-list">
          ${entries.map(({ recipe: r, mult }) => `<div class="week-row">
            <a class="thumb" href="#/r/${r.id}">${r.image_url ? `<img src="${esc(r.image_url)}" alt="">` : `<div class="placeholder">${icon('utensils')}</div>`}</a>
            <a class="week-title" href="#/r/${r.id}">${esc(r.title)}</a>
            ${state.me ? `<span class="scaler">${[0.5, 1, 2, 3].map((m) =>
                `<button data-scale="${r.id}" data-mult="${m}" class="${m === mult ? 'on' : ''}">${fmtMult(m)}</button>`).join('')}</span>
              <button class="ghost danger" data-remove="${r.id}" title="Remove from this week">${icon('x')}</button>`
              : `<span class="muted">${fmtMult(mult)}</span>`}
          </div>`).join('')}
        </section>
        <section class="card">
          <div class="card-head">
            <h2>Grocery list <span class="muted count">${itemCount} items</span></h2>
            <span class="actions" style="margin:0">
              <button id="uncheck">Uncheck all</button>
              ${navigator.share ? '<button class="g-share">Share</button>' : ''}
              <button class="primary g-copy">Copy</button>
            </span>
          </div>
          ${groceryHtml(groups, checked, true)}
        </section>
        ${state.me ? '<p class="center"><button class="danger" id="clear-week">Clear this week</button></p>' : ''}`
      : `<div class="empty">Nothing planned yet. Open a recipe and tap <strong>This week</strong>.</div>`}
    </div>`;

  if (!entries.length) return;
  wireGroceryButtons($app, groceryText('Groceries — this week', groups));

  $app.querySelectorAll('.grocery input[type=checkbox]').forEach((cb) => cb.onchange = () => {
    cb.checked ? checked.add(cb.dataset.key) : checked.delete(cb.dataset.key);
    saveChecked(checked);
  });
  $app.querySelector('#uncheck').onclick = () => { saveChecked(new Set()); renderWeek(); };

  $app.querySelectorAll('[data-scale]').forEach((b) => b.onclick = async () => {
    const { error } = await sb.from('week_list').update({ multiplier: +b.dataset.mult }).eq('recipe_id', b.dataset.scale);
    error ? fail(error) : renderWeek();
  });
  $app.querySelectorAll('[data-remove]').forEach((b) => b.onclick = async () => {
    const { error } = await sb.from('week_list').delete().eq('recipe_id', b.dataset.remove);
    error ? fail(error) : renderWeek();
  });
  $app.querySelector('#clear-week')?.addEventListener('click', async () => {
    if (!confirm('Clear every recipe from this week?')) return;
    const { error } = await sb.from('week_list').delete().in('recipe_id', entries.map((e) => e.recipe.id));
    if (error) return fail(error);
    saveChecked(new Set());
    renderWeek();
  });
}

// ── Cook mode ──────────────────────────────────────────────────────────────
let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
  return !!wakeLock;
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
// The browser drops the lock when the tab is hidden; take it back when the cook returns.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && location.hash.startsWith('#/cook/')) keepAwake();
});

async function renderCook(id, mult) {
  const r = await getRecipe(id);
  const storeKey = `cook-${id}`;
  let done;  // {ing: [indexes], steps: [indexes]} — survives a reload mid-cook
  try { done = JSON.parse(sessionStorage.getItem(storeKey)) ?? {}; } catch { done = {}; }
  const ing = new Set(done.ing ?? []);
  const steps = new Set(done.steps ?? []);
  const save = () => {
    try { sessionStorage.setItem(storeKey, JSON.stringify({ ing: [...ing], steps: [...steps] })); } catch { /* private mode */ }
  };

  const draw = () => {
    const current = r.steps.findIndex((_, i) => !steps.has(i));
    $app.innerHTML = `
      <div class="cook">
        <div class="cook-head">
          <a class="back" href="#/r/${r.id}">${icon('x')} Exit</a>
          <span class="muted" id="awake"></span>
        </div>
        <h1>${esc(r.title)}${mult !== 1 ? ` <span class="muted">(${fmtMult(mult)})</span>` : ''}</h1>
        <div class="cook-grid">
          <section>
            <h2>Ingredients</h2>
            ${r.ingredients.length ? `<ul class="cook-ings">${r.ingredients.map((i, n) => i.section
              ? `<li class="section">${esc(i.section)}</li>`
              : `<li><button data-ing="${n}" class="${ing.has(n) ? 'done' : ''}">${esc(formatIngredient(i, mult))}</button></li>`).join('')}</ul>`
              : '<p class="muted">No ingredients listed.</p>'}
          </section>
          <section>
            <h2>Steps</h2>
            ${r.steps.length ? `<ol class="cook-steps">${r.steps.map((s, n) =>
              `<li><button data-step="${n}" class="${steps.has(n) ? 'done' : ''}${n === current ? ' current' : ''}">
                <span class="num">${steps.has(n) ? icon('check') : n + 1}</span><span>${esc(s)}</span></button></li>`).join('')}</ol>
              ${current === -1 ? `<p class="cook-done">All done. ${state.me ? `<a href="#/r/${r.id}">Log that you made it</a>` : ''}</p>` : ''}`
              : '<p class="muted">No steps listed.</p>'}
          </section>
        </div>
        ${ing.size || steps.size ? '<p class="center"><button id="cook-reset">Start over</button></p>' : ''}
      </div>`;

    $app.querySelectorAll('[data-ing]').forEach((b) => b.onclick = () => {
      const n = +b.dataset.ing;
      ing.has(n) ? ing.delete(n) : ing.add(n);
      save(); draw();
    });
    $app.querySelectorAll('[data-step]').forEach((b) => b.onclick = () => {
      const n = +b.dataset.step;
      steps.has(n) ? steps.delete(n) : steps.add(n);
      save(); draw();
      $app.querySelector('.cook-steps .current')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    $app.querySelector('#cook-reset')?.addEventListener('click', () => {
      ing.clear(); steps.clear(); save(); draw();
    });
    $app.querySelector('#awake').textContent = wakeLock ? 'Screen stays on' : '';
  };

  draw();
  if (await keepAwake()) $app.querySelector('#awake').textContent = 'Screen stays on';
}

// ── Add / Edit ─────────────────────────────────────────────────────────────
function renderForm(r, captured = null) {
  if (!state.me) {
    $app.innerHTML = `<div class="empty">Log in to add or edit recipes${
      captured ? ' — then press Save to Recipe Rolodex on that page again' : ''}.</div>`;
    return;
  }
  const editing = !!r;
  let imported = null;
  if (captured) {
    try { imported = fromCapture(JSON.parse(captured)); }
    catch (e) { fail(e, "Couldn't read that page"); }
  }
  if (imported?.pasteText) {
    // No recipe data on that page — best-guess the recipe from its text.
    const p = parsePasted(imported.pasteText);
    Object.assign(imported.recipe, {
      title: imported.recipe.title || p.title,
      ingredients: parseIngredients(p.ingredients.join('\n')),
      steps: p.steps, servings: p.servings, prep_min: p.prep_min, cook_min: p.cook_min,
    });
  }
  r ??= imported?.recipe ?? { title: '', ingredients: [], steps: [], tags: [], want_to_try: true };
  let mode = 'manual';
  const site = location.origin + location.pathname;
  let imageUrl = r.image_url ?? '';
  const tags = new Set(r.tags);

  $app.innerHTML = `
    <form class="form" id="recipe-form">
      <p><a class="back" href="${editing ? `#/r/${r.id}` : '#/'}">${icon('arrowLeft')} Back</a></p>
      <h1>${editing ? 'Edit recipe' : 'Add a recipe'}</h1>
      ${imported?.recipe && !imported.pasteText ? `<div class="banner">Imported from ${esc(hostOf(r.source_url))} — give it a once-over, then save.</div>` : ''}
      ${imported?.pasteText ? `<div class="banner">That page didn't include recipe data, so this is a best guess from its text — check the ingredients and steps carefully before saving.</div>` : ''}
      ${editing ? '' : `<div class="seg" id="mode">
        <button type="button" data-mode="manual">Type it in</button>
        <button type="button" data-mode="link">From a website</button>
        <button type="button" data-mode="paste">Paste text</button>
      </div>`}

      <div data-pane="link">
        <div class="card">
          <h2>Save to Recipe Rolodex button</h2>
          <p>Most recipe sites block links from being read by a server, so this button reads the recipe from the page you have open and brings it here, filled in. Set it up once per browser:</p>
          <p><strong>On a computer:</strong> drag this onto your bookmarks bar:
            <a class="btn primary" id="bookmarklet" href="${bookmarkletHref(site)}">${icon('download')} Save to Recipe Rolodex</a></p>
          <p><strong>On iPhone (Safari):</strong></p>
          <ol class="hint">
            <li><button type="button" id="copy-bm">Copy the button code</button></li>
            <li>Bookmark any page (Share, then Add Bookmark), name it <em>Save to Recipe Rolodex</em>.</li>
            <li>Open Bookmarks, tap Edit, tap it, replace the address with the copied code, then Done.</li>
            <li>On a recipe page, open Bookmarks and tap <em>Save to Recipe Rolodex</em>.</li>
          </ol>
        </div>
        <label>Or just save the link for later</label>
        <input type="url" name="link" placeholder="https://…">
        <p class="hint">Saves a placeholder with just the link — fill it in later with Edit.</p>
      </div>
      <div data-pane="paste">
        <label>Paste the recipe</label>
        <textarea name="paste" placeholder="Paste the whole thing — title, ingredients, steps, whatever you've got." style="min-height:240px"></textarea>
        <p class="hint">Works best when the text has “Ingredients” and “Instructions” headings.</p>
        <div class="modal-actions"><button type="button" class="primary" id="sort-paste">Sort it into the form ${icon('arrowRight')}</button></div>
      </div>

      <div data-pane="manual">
        <label>Title</label>
        <input name="title" value="${esc(r.title)}" ${editing ? '' : 'autofocus'}>

        <label>Photo</label>
        <div class="img-pick">
          <div class="preview" id="preview">${imageUrl ? `<img src="${esc(imageUrl)}" alt="">` : `<div class="placeholder">${icon('utensils')}</div>`}</div>
          <div class="fields">
            <input type="file" accept="image/*" id="file">
            <input name="image_url" placeholder="…or an image URL" value="${esc(imageUrl)}">
          </div>
        </div>

        <label>Source link <span class="muted">(optional)</span></label>
        <input type="url" name="source_url" value="${esc(r.source_url ?? '')}" placeholder="https://…">

        <div class="row">
          <div><label>Serves</label><input type="number" step="any" min="0" name="servings" value="${esc(r.servings ?? '')}"></div>
          <div><label>Prep (min)</label><input type="number" min="0" name="prep_min" value="${esc(r.prep_min ?? '')}"></div>
          <div><label>Cook (min)</label><input type="number" min="0" name="cook_min" value="${esc(r.cook_min ?? '')}"></div>
        </div>

        <label>Ingredients <span class="muted">— one per line. End a line with “:” for a section.</span></label>
        <textarea name="ingredients" style="min-height:200px" placeholder="1 1/2 cups chicken broth&#10;2 tbsp olive oil, divided&#10;&#10;For the sauce:&#10;3 cloves garlic, minced">${esc(r.ingredients.map((i) => formatIngredient(i)).join('\n'))}</textarea>

        <label>Steps <span class="muted">— one per line</span></label>
        <textarea name="steps" style="min-height:200px">${esc(r.steps.join('\n'))}</textarea>

        <label>Notes <span class="muted">(optional)</span></label>
        <textarea name="notes" style="min-height:70px">${esc(r.notes ?? '')}</textarea>
      </div>

      <label>Tags</label>
      ${tagGroups().map(([g, list]) => `<div class="chip-group"><span class="group-label">${g}</span>
        ${list.map((t) => `<button type="button" class="${chipClass(t)}${tags.has(t) ? ' on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}
      </div>`).join('')}
      <input name="custom_tags" placeholder="New tags, comma separated (e.g. thai, grill)">

      <label class="checkbox"><input type="checkbox" name="want_to_try" ${r.want_to_try ? 'checked' : ''}> Want to try</label>

      <div class="form-actions">
        ${editing ? '<button type="button" class="danger" id="delete">Delete recipe</button>' : '<span></span>'}
        <button class="primary" id="save">${editing ? 'Save changes' : 'Save recipe'}</button>
      </div>
    </form>`;

  const $form = $app.querySelector('#recipe-form');

  const showMode = (m) => {
    mode = m;
    $form.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x.dataset.mode === m));
    $form.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== m));
  };
  showMode(mode);
  $form.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => showMode(b.dataset.mode));

  $form.querySelector('#bookmarklet').onclick = (e) => {
    e.preventDefault();
    toast('Drag it to your bookmarks bar instead of clicking');
  };
  $form.querySelector('#copy-bm').onclick = async () => {
    await navigator.clipboard.writeText(decodeURIComponent(bookmarkletHref(site)));
    toast('Copied — now paste it as a bookmark address');
  };

  const sortPaste = () => {
    const text = $form.elements.paste.value.trim();
    if (!text) return toast('Paste something first');
    const p = parsePasted(text);
    const f = $form.elements;
    if (!f.title.value.trim()) f.title.value = p.title;
    f.ingredients.value = p.ingredients.join('\n');
    f.steps.value = p.steps.join('\n');
    if (p.servings) f.servings.value = p.servings;
    if (p.prep_min) f.prep_min.value = p.prep_min;
    if (p.cook_min) f.cook_min.value = p.cook_min;
    showMode('manual');
    window.scrollTo(0, 0);
    toast(`Found ${p.ingredients.length} ingredients and ${p.steps.length} steps — check them over, then save`);
  };
  $form.querySelector('#sort-paste').onclick = sortPaste;

  $form.querySelectorAll('[data-tag]').forEach((b) => b.onclick = () => {
    const t = b.dataset.tag;
    tags.has(t) ? tags.delete(t) : tags.add(t);
    b.classList.toggle('on');
  });

  const setPreview = (url) => {
    $form.querySelector('#preview').innerHTML = url ? `<img src="${esc(url)}" alt="">` : `<div class="placeholder">${icon('utensils')}</div>`;
  };
  $form.elements.image_url.oninput = (e) => { imageUrl = e.target.value.trim(); setPreview(imageUrl); };
  $form.querySelector('#file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      toast('Uploading photo…');
      imageUrl = await uploadImage(file);
      $form.elements.image_url.value = imageUrl;
      setPreview(imageUrl);
      toast('Photo uploaded');
    } catch (err) { fail(err, 'Upload failed'); }
  };

  $form.querySelector('#delete')?.addEventListener('click', () => deleteRecipe(r));

  $form.onsubmit = async (e) => {
    e.preventDefault();
    const f = $form.elements;
    for (const t of f.custom_tags.value.split(',')) if (t.trim()) tags.add(t.trim().toLowerCase());

    const common = { tags: [...tags], want_to_try: f.want_to_try.checked };
    let row;
    if (mode === 'link') {
      const url = f.link.value.trim();
      if (!url) return toast('Paste a link first');
      row = { ...common, title: hostOf(url), source_url: url, status: 'stub' };
    } else if (mode === 'paste') {
      return sortPaste();  // review in the form before saving
    } else {
      const num = (v) => v === '' ? null : Number(v);
      row = {
        ...common,
        title: f.title.value.trim() || 'Untitled recipe',
        image_url: imageUrl || null,
        source_url: f.source_url.value.trim() || null,
        servings: num(f.servings.value),
        prep_min: num(f.prep_min.value),
        cook_min: num(f.cook_min.value),
        ingredients: parseIngredients(f.ingredients.value),
        steps: f.steps.value.split('\n').map((s) => s.trim()).filter(Boolean),
        notes: f.notes.value.trim() || null,
      };
      // a placeholder that's been filled in is done
      if (!editing || row.ingredients.length || row.steps.length) row.status = 'complete';
    }

    $form.querySelector('#save').disabled = true;
    const q = editing
      ? sb.from('recipes').update(row).eq('id', r.id).select().single()
      : sb.from('recipes').insert({ ...row, added_by: state.me }).select().single();
    const { data, error } = await q;
    $form.querySelector('#save').disabled = false;
    if (error) return fail(error, 'Save failed');
    toast('Saved');
    location.hash = `#/r/${data.id}`;
  };
}

// Ratings, cook log and comments go with it (ON DELETE CASCADE); an uploaded photo is removed too.
async function deleteRecipe(r) {
  if (!confirm(`Delete “${r.title}” for good? Its ratings, history and comments go with it.`)) return;
  const { error } = await sb.from('recipes').delete().eq('id', r.id);
  if (error) return fail(error, 'Delete failed');
  const ownPhoto = r.image_url?.split('/storage/v1/object/public/recipe-images/')[1];
  if (ownPhoto) await sb.storage.from('recipe-images').remove([ownPhoto]);
  toast('Deleted');
  location.hash = '#/';
}

async function uploadImage(file) {
  const blob = await resizeImage(file, 1600);
  const path = `${crypto.randomUUID()}.jpg`;
  const { error } = await sb.storage.from('recipe-images').upload(path, blob, { contentType: 'image/jpeg' });
  if (error) throw error;
  return sb.storage.from('recipe-images').getPublicUrl(path).data.publicUrl;
}

async function resizeImage(file, max) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
}

// ── Boot ───────────────────────────────────────────────────────────────────
$modal.addEventListener('click', (e) => { if (e.target === $modal) $modal.close(); });
window.addEventListener('hashchange', route);
sb.auth.onAuthStateChange((event) => {
  if (event !== 'SIGNED_IN' && event !== 'SIGNED_OUT') return;
  // Defer: calling Supabase inside this callback can deadlock. Only re-render if who's
  // logged in actually changed — SIGNED_IN also fires on token refresh and would wipe a form.
  setTimeout(async () => {
    const before = state.me;
    await refreshMe();
    if (state.me !== before) route();
  });
});
await refreshMe();
route();
