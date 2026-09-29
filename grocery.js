// Merge ingredients from several recipes into one grocery list grouped by store section.

import { formatIngredient } from './ingredients.js';

// unit → [family, size in the family's base unit]
const FAMILY = {
  tsp: ['vol', 1], tbsp: ['vol', 3], cup: ['vol', 48], 'fl oz': ['vol', 6], pint: ['vol', 96], qt: ['vol', 192],
  ml: ['ml', 1], l: ['ml', 1000],
  oz: ['wt', 1], lb: ['wt', 16],
  g: ['g', 1], kg: ['g', 1000],
};

const roundUp = (n, step) => Math.ceil(n / step - 1e-9) * step;  // shop for a bit more, never less

function bestUnit(family, total) {
  switch (family) {
    case 'vol': return total >= 12 ? ['cup', roundUp(total / 48, 1 / 8)]
      : total >= 3 ? ['tbsp', roundUp(total / 3, 1 / 2)] : ['tsp', roundUp(total, 1 / 8)];
    case 'wt': return total >= 16 ? ['lb', total / 16] : ['oz', total];
    case 'ml': return total >= 1000 ? ['l', total / 1000] : ['ml', total];
    case 'g': return total >= 1000 ? ['kg', total / 1000] : ['g', total];
    default: return [family.startsWith('u:') ? family.slice(2) : null, total];
  }
}

// Drop parentheticals, including half-open ones left by older imports: "yellow onion (" → "yellow onion"
export function cleanItem(item) {
  let s = String(item);
  while (/\([^()]*\)/.test(s)) s = s.replace(/\([^()]*\)/g, '');
  return s.replace(/[()].*$/, '').replace(/\s+/g, ' ').replace(/[\s,;:.-]+$/, '').trim();
}

const SIZE_WORDS = /^(large|medium|small|extra[- ]large|fresh|whole|boneless|skinless|chopped|diced|minced|sliced|shredded|grated)\s+/;
const MEATS = /^(beef|pork|turkey|chicken|lamb|veal|meat|sausage)\b/;

// Key used to spot the same ingredient across recipes: "Large Yellow Onions (diced)" → "yellow onion"
export function itemKey(item) {
  let s = cleanItem(item).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  while (SIZE_WORDS.test(s)) s = s.replace(SIZE_WORDS, '');
  if (s.startsWith('ground ') && !MEATS.test(s.slice(7))) s = s.slice(7);  // ground cumin = cumin
  const words = s.split(' ');
  const last = words.pop() ?? '';
  const singular = last === 'leaves' ? 'leaf'
    : /ies$/.test(last) ? last.slice(0, -3) + 'y'
    : /oes$/.test(last) ? last.slice(0, -2)
    : /[^su]s$/.test(last) && last.length > 3 ? last.slice(0, -1) : last;
  return [...words, singular].join(' ');
}

const STAPLES = /^(water|ice|(kosher |sea |table )?salt|((freshly )?ground )?(black )?pepper|salt (and|&) (black )?pepper|(extra virgin |extra-virgin )?olive oil|(vegetable|canola|neutral) oil|cooking spray|nonstick spray)\b|to taste$/;

// First match wins, so order matters: "garlic powder" is a spice before "garlic" is produce,
// "chicken broth" is pantry before "chicken" is meat.
const SECTIONS = [
  ['Frozen', /\bfrozen\b/],
  ['Produce', /\b(bean sprouts?|green beans?|snap peas?|green onions?)\b/],
  ['Spices & Seasonings', /\b(salt|black pepper|peppercorns?|pepper flakes|cumin|paprika|chili powder|chile powder|oregano|cinnamon|nutmeg|cayenne|garlic powder|onion powder|dried (thyme|basil|parsley|rosemary|dill)|bay lea(f|ves)|seasoning|curry powder|turmeric|coriander|allspice|cloves ground|ground (ginger|cloves|cinnamon|coriander)|vanilla|five spice|garam masala|za'?atar|sumac)\b|^cloves?$/],  // bare "clove" key = the spice; garlic keeps its name
  ['Pantry', /\b(cans?|canned|jarred|broth|stock|bouillon|paste|sauce|noodles?|pasta|spaghetti|penne|macaroni|tortellini|rice|quinoa|couscous|oats?|flour|sugar|beans?|lentils?|chickpeas?|oil|vinegar|honey|maple|syrup|peanut butter|almond butter|soy|tamari|mirin|mustard|ketchup|mayo|mayonnaise|baking (soda|powder)|cornstarch|chocolate|cocoa|raisins|nuts?|almonds?|walnuts?|pecans?|cashews?|seeds?|breadcrumbs|panko|crackers|salsa|coconut milk)\b/],
  ['Meat & Seafood', /\b(chicken|beef|pork|turkey|sausages?|bacon|ham|steak|lamb|veal|chorizo|prosciutto|pancetta|meatballs?|ground|chuck|roast|brisket|tenderloin|ribs|thighs?|breasts?|drumsticks?|salmon|shrimp|prawns?|fish|cod|tilapia|halibut|tuna|scallops?|crab|mahi)\b/],
  ['Dairy & Eggs', /\b(milk|butter|buttermilk|cheese|cheddar|parmesan|mozzarella|feta|ricotta|gruyere|goat cheese|cream|creme fraiche|yogurt|eggs?|half-and-half|half and half|ghee)\b/],
  ['Bakery', /\b(bread|buns?|tortillas?|pitas?|naan|baguette|rolls?|bagels?|english muffins?|croissants?)\b/],
  ['Produce', /\b(onions?|garlic|shallots?|scallions?|leeks?|carrots?|celery|potato(es)?|sweet potato|yams?|tomato(es)?|peppers?|jalapeno|jalapeño|chiles?|lettuce|spinach|kale|arugula|greens|cabbage|broccoli|cauliflower|zucchini|squash|pumpkin|cucumbers?|mushrooms?|eggplant|asparagus|brussels|green beans|peas|corn|avocados?|lemons?|limes?|oranges?|apples?|pears?|bananas?|berries|strawberries|blueberries|raspberries|grapes|mango|pineapple|cilantro|parsley|basil|mint|dill|thyme|rosemary|sage|chives|ginger|herbs|sprouts|radish(es)?|beets?|fennel|bok choy)\b/],
];
const SECTION_ORDER = ['Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Bakery', 'Pantry',
  'Spices & Seasonings', 'Frozen', 'Other', 'You probably have'];

// Checks the singularized key and the original wording, so "raisins" and "raisin" both match.
export function sectionFor(key, item = key) {
  if (STAPLES.test(key)) return 'You probably have';
  const text = cleanItem(item).toLowerCase();
  return SECTIONS.find(([, re]) => re.test(key) || re.test(text))?.[0] ?? 'Other';
}

// entries: [{recipe, mult}] → [{section, items: [{key, label, sources}]}]
export function buildGroceryList(entries) {
  const byKey = new Map();
  for (const { recipe, mult } of entries) {
    for (const ing of recipe.ingredients) {
      if (ing.section || !ing.item) continue;
      const key = itemKey(ing.item);
      if (!key) continue;
      const row = byKey.get(key) ?? { key, item: cleanItem(ing.item), totals: new Map(), sources: new Set() };
      row.sources.add(recipe.title);
      const qty = ing.qty_max ?? ing.qty;  // buy for the top of a range
      if (qty != null) {
        const [family, size] = FAMILY[ing.unit] ?? [`u:${ing.unit ?? ''}`, 1];
        row.totals.set(family, (row.totals.get(family) ?? 0) + qty * size * mult);
      }
      byKey.set(key, row);
    }
  }
  const sections = new Map();
  for (const row of byKey.values()) {
    const amounts = [...row.totals].map(([family, total]) => {
      const [unit, qty] = bestUnit(family, total);
      return formatIngredient({ qty, unit: unit || null, item: '' }).trim();
    });
    const label = amounts.length ? `${amounts.join(' + ')} ${row.item}` : row.item;
    const section = sectionFor(row.key, row.item);
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section).push({ key: row.key, label, sources: [...row.sources] });
  }
  return SECTION_ORDER.filter((s) => sections.has(s)).map((section) => ({
    section,
    items: sections.get(section).sort((a, b) => a.key.localeCompare(b.key)),
  }));
}

export const groceryText = (title, groups) => `${title}\n` + groups.map(({ section, items }) =>
  `\n${section.toUpperCase()}\n` + items.map((i) => `☐ ${i.label}`).join('\n')).join('\n');
