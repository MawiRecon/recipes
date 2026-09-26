// Ingredient lines ⇄ structured {qty, qty_max, unit, item, note} | {section}.

const FRACTIONS = { '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅛': '1/8',
  '⅜': '3/8', '⅝': '5/8', '⅞': '7/8', '⅕': '1/5', '⅖': '2/5', '⅙': '1/6', '⅚': '5/6' };

const UNIT_ALIASES = {
  cup: ['cup', 'cups', 'c.'],
  tbsp: ['tbsp', 'tbsp.', 'tbs', 'tablespoon', 'tablespoons', 'T'],
  tsp: ['tsp', 'tsp.', 'teaspoon', 'teaspoons', 't'],
  oz: ['oz', 'oz.', 'ounce', 'ounces'],
  'fl oz': ['fl oz', 'fl. oz.'],
  lb: ['lb', 'lb.', 'lbs', 'lbs.', 'pound', 'pounds'],
  g: ['g', 'gram', 'grams'],
  kg: ['kg', 'kilogram', 'kilograms'],
  ml: ['ml', 'milliliter', 'milliliters'],
  l: ['liter', 'liters', 'litre', 'litres'],
  qt: ['qt', 'quart', 'quarts'],
  pint: ['pint', 'pints'],
  clove: ['clove', 'cloves'],
  can: ['can', 'cans'],
  jar: ['jar', 'jars'],
  package: ['package', 'packages', 'pkg'],
  bunch: ['bunch', 'bunches'],
  sprig: ['sprig', 'sprigs'],
  stick: ['stick', 'sticks'],
  slice: ['slice', 'slices'],
  piece: ['piece', 'pieces'],
  head: ['head', 'heads'],
  pinch: ['pinch', 'pinches'],
  dash: ['dash', 'dashes'],
};
const PLURAL = { cup: 'cups', clove: 'cloves', can: 'cans', jar: 'jars', package: 'packages',
  bunch: 'bunches', sprig: 'sprigs', stick: 'sticks', slice: 'slices', piece: 'pieces',
  head: 'heads', pinch: 'pinches', dash: 'dashes', pint: 'pints' };

const aliasToUnit = new Map();
for (const [unit, aliases] of Object.entries(UNIT_ALIASES))
  for (const a of aliases) aliasToUnit.set(a.length === 1 ? a : a.toLowerCase(), unit);

const NUM = String.raw`(?:\d+\s+\d+\/\d+|\d+\/\d+|\d*\.\d+|\d+)`;
const QTY_RE = new RegExp(String.raw`^(${NUM})(?:\s*(?:-|–|to)\s*(${NUM}))?\s*`);

export function parseNumber(s) {
  s = s.trim();
  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return +mixed[1] + mixed[2] / mixed[3];
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) return frac[1] / frac[2];
  return parseFloat(s);
}

function normalize(line) {
  return line
    .replace(/(\d)([½⅓⅔¼¾⅛⅜⅝⅞⅕⅖⅙⅚])/g, '$1 $2')
    .replace(/[½⅓⅔¼¾⅛⅜⅝⅞⅕⅖⅙⅚]/g, (c) => FRACTIONS[c])
    .replace(/^[-•*▢□]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseLine(raw) {
  const line = normalize(raw);
  if (!line) return null;
  if (/:$/.test(line) && line.length < 60) return { section: line.slice(0, -1) };

  const out = { qty: null, qty_max: null, unit: null, item: line, note: null };
  let rest = line;
  const m = rest.match(QTY_RE);
  if (m) {
    out.qty = parseNumber(m[1]);
    if (m[2]) out.qty_max = parseNumber(m[2]);
    rest = rest.slice(m[0].length);
    // unit: try two words ("fl oz") then one
    const words = rest.split(' ');
    for (const n of [2, 1]) {
      const cand = words.slice(0, n).join(' ');
      const unit = aliasToUnit.get(cand) ?? aliasToUnit.get(cand.toLowerCase());
      if (unit && words.length > n) { out.unit = unit; rest = words.slice(n).join(' '); break; }
    }
    rest = rest.replace(/^of\s+/i, '');
  }
  const comma = rest.indexOf(',');
  if (comma > 0) { out.item = rest.slice(0, comma).trim(); out.note = rest.slice(comma + 1).trim(); }
  else out.item = rest;
  return out;
}

export const parseIngredients = (text) =>
  text.split('\n').map(parseLine).filter(Boolean);

const NICE = [[0, ''], [1 / 8, '1/8'], [1 / 6, '1/6'], [1 / 4, '1/4'], [1 / 3, '1/3'], [3 / 8, '3/8'], [1 / 2, '1/2'],
  [5 / 8, '5/8'], [2 / 3, '2/3'], [3 / 4, '3/4'], [7 / 8, '7/8'], [1, '']];

export function formatQty(n) {
  if (n == null || isNaN(n)) return '';
  const whole = Math.floor(n);
  const frac = n - whole;
  const [val, label] = NICE.reduce((best, cur) =>
    Math.abs(cur[0] - frac) < Math.abs(best[0] - frac) ? cur : best);
  if (Math.abs(val - frac) > 0.04) return String(Math.round(n * 100) / 100);
  const w = whole + (val === 1 ? 1 : 0);
  if (!label) return String(w);
  return w ? `${w} ${label}` : label;
}

export function formatIngredient(ing, mult = 1) {
  if (ing.section) return `${ing.section}:`;
  const parts = [];
  if (ing.qty != null) {
    let q = formatQty(ing.qty * mult);
    if (ing.qty_max != null) q += `–${formatQty(ing.qty_max * mult)}`;
    parts.push(q);
  }
  if (ing.unit) {
    const plural = (ing.qty_max ?? ing.qty) * mult > 1 && PLURAL[ing.unit];
    parts.push(plural || ing.unit);
  }
  parts.push(ing.item);
  return parts.join(' ') + (ing.note ? `, ${ing.note}` : '');
}
