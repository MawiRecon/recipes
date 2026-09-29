// "Save to Recipe Box" bookmarklet + turning what it captures into a recipe row.
// Most recipe sites block server-side fetches (Cloudflare challenges), so we read the
// schema.org Recipe data from the page the person already has open in their own browser.

import { TAG_GROUPS } from './config.js';
import { parseIngredients } from './ingredients.js';

// Runs on the recipe site. Keep it free of `//` comments — it's flattened into a URL.
function capture(site) {
  let recipe = null;
  const find = (o) => {
    if (recipe || !o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(find); return; }
    if ([].concat(o['@type'] || []).includes('Recipe')) { recipe = o; return; }
    find(o['@graph']);
    find(o.mainEntity);
  };
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try { find(JSON.parse(s.textContent)); } catch (e) { }
  });
  const meta = (p) => document.querySelector(`meta[property="${p}"]`)?.content;
  const keys = ['name', 'image', 'recipeIngredient', 'recipeInstructions', 'recipeYield',
    'prepTime', 'cookTime', 'totalTime', 'recipeCategory', 'recipeCuisine', 'keywords'];
  const data = recipe
    ? Object.fromEntries(keys.map((k) => [k, recipe[k]]))
    : { name: meta('og:title') || document.title, image: meta('og:image'),
        text: (getSelection().toString() || document.body.innerText).slice(0, 12000) };
  data.url = location.href.split('#')[0];
  location.href = site + '#/new?import=' + encodeURIComponent(JSON.stringify(data));
}

export const bookmarkletHref = (site) =>
  'javascript:' + encodeURIComponent(`(${capture})(${JSON.stringify(site)})`);

// ── Normalizing captured schema.org data ───────────────────────────────────
const text = (s) => {
  const el = document.createElement('div');
  el.innerHTML = String(s ?? '');
  return el.textContent.replace(/\s+/g, ' ').trim();
};

const firstImage = (img) => {
  if (!img) return null;
  if (Array.isArray(img)) {  // sites often list 1x1, 4x3, 16x9 crops — tiles are 4:3
    const urls = img.map(firstImage).filter(Boolean);
    return urls.find((u) => /4x3/.test(u)) ?? urls[0] ?? null;
  }
  if (typeof img === 'object') return img.url ?? img.contentUrl ?? null;
  return img;
};

const minutes = (iso) => {
  const m = String(iso ?? '').match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/);
  if (!m || !m[0] || m[0] === 'P') return null;
  const total = (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0);
  return total || null;
};

const servings = (y) => {
  const n = String([].concat(y ?? [])[0] ?? '').match(/\d+(\.\d+)?/);
  return n ? +n[0] : null;
};

function flattenSteps(ins) {
  if (!ins) return [];
  if (typeof ins === 'string')
    return ins.replace(/<\/(p|li)>|<br\s*\/?>/gi, '\n').split('\n').map(text).filter(Boolean);
  if (Array.isArray(ins)) return ins.flatMap(flattenSteps);
  if (ins.itemListElement) return flattenSteps(ins.itemListElement);  // HowToSection
  return [text(ins.text ?? ins.name)].filter(Boolean);                 // HowToStep
}

const CATEGORY_TO_MEAL = { 'main course': 'dinner', 'main dish': 'dinner', entree: 'dinner',
  dinner: 'dinner', lunch: 'lunch', breakfast: 'breakfast', brunch: 'breakfast',
  'side dish': 'side', side: 'side', dessert: 'dessert', snack: 'snack', appetizer: 'snack',
  drink: 'drink', beverage: 'drink', salad: 'salad', soup: 'soup' };

function suggestTags(d) {
  const cats = [].concat(d.recipeCategory ?? []).map((c) => text(c).toLowerCase());
  const hay = [d.name, ...cats, [].concat(d.recipeCuisine ?? []).join(' '),
    [].concat(d.keywords ?? []).join(' ')].map(text).join(' ').toLowerCase();
  const tags = new Set(cats.map((c) => CATEGORY_TO_MEAL[c]).filter(Boolean));
  for (const t of Object.values(TAG_GROUPS).flat())
    if (new RegExp(`\\b${t.replace('-', '[- ]')}\\b`).test(hay)) tags.add(t);
  return [...tags];
}

// Returns {recipe, pasteText}: a prefilled recipe, plus the raw page text when no Recipe data was found.
export function fromCapture(d) {
  if (d.text != null) {
    return { pasteText: `${text(d.name)}\n${d.url}\n\n${d.text}`, recipe: {
      title: text(d.name).split(/\s[|–—-]\s/)[0], source_url: d.url, image_url: firstImage(d.image),
      ingredients: [], steps: [], tags: [], want_to_try: true } };
  }
  return { recipe: {
    title: text(d.name) || 'Untitled recipe',
    source_url: d.url,
    image_url: firstImage(d.image),
    servings: servings(d.recipeYield),
    prep_min: minutes(d.prepTime),
    cook_min: minutes(d.cookTime) ?? (minutes(d.totalTime) && !minutes(d.prepTime) ? minutes(d.totalTime) : null),
    ingredients: parseIngredients([].concat(d.recipeIngredient ?? []).map(text).join('\n')),
    steps: flattenSteps(d.recipeInstructions),
    tags: suggestTags(d),
    want_to_try: true,
  } };
}
