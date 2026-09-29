// Best-guess split of pasted recipe text into title / ingredients / steps / servings / times.
// Works off section headings ("Ingredients", "Instructions"…) and falls back to line shape.

const ING_HEAD = /^(ingredients?|what you('| wi)ll need|you('| wi)ll need|shopping list)\b/i;
const STEP_HEAD = /^(instructions?|directions?|method|steps|preparation|how to make( it)?|cooking instructions)\b/i;
const STOP_HEAD = /^(notes?|nutrition|tips|video|equipment|storage|faq|recipe notes|comments?|reviews?)\b/i;

const isHeading = (l) => l.length < 40 && (ING_HEAD.test(l) || STEP_HEAD.test(l) || STOP_HEAD.test(l));
const looksLikeIngredient = (l) =>
  /^([-•*▢□]\s*)?(\d|[½⅓⅔¼¾⅛]|a (pinch|dash|handful)|pinch|salt|pepper)/i.test(l) && l.length < 120;
const stripStepNumber = (l) => l.replace(/^(step\s*)?\d+[.):]?\s+/i, '').replace(/^[-•*]\s*/, '');

function minutesFrom(text, label) {
  const m = text.match(new RegExp(`${label}[^\\n\\d]{0,15}(?:(\\d+)\\s*h(?:ou)?rs?)?\\s*(?:(\\d+)\\s*m(?:in(?:ute)?s?)?)?`, 'i'));
  if (!m || (!m[1] && !m[2])) return null;
  return (+m[1] || 0) * 60 + (+m[2] || 0) || null;
}

export function parsePasted(raw) {
  const lines = raw.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = { title: '', ingredients: [], steps: [], servings: null, prep_min: null, cook_min: null };
  if (!lines.length) return out;

  const serves = raw.match(/(?:serves|servings|yield|makes)\s*:?\s*(\d+)/i);
  if (serves) out.servings = +serves[1];
  out.prep_min = minutesFrom(raw, 'prep(?:aration)?(?: time)?');
  out.cook_min = minutesFrom(raw, 'cook(?:ing)?(?: time)?');

  if (!isHeading(lines[0]) && !looksLikeIngredient(lines[0])) out.title = lines[0].slice(0, 120);

  const ingAt = lines.findIndex((l) => l.length < 40 && ING_HEAD.test(l));
  const stepAt = lines.findIndex((l, i) => i > ingAt && l.length < 40 && STEP_HEAD.test(l));

  if (ingAt >= 0) {
    const end = stepAt > ingAt ? stepAt : lines.length;
    out.ingredients = lines.slice(ingAt + 1, end).filter((l) => !STOP_HEAD.test(l));
    if (stepAt > ingAt) {
      const stop = lines.findIndex((l, i) => i > stepAt && l.length < 40 && STOP_HEAD.test(l));
      out.steps = lines.slice(stepAt + 1, stop > 0 ? stop : lines.length)
        .filter((l) => !/^step \d+$/i.test(l)).map(stripStepNumber).filter(Boolean);
    }
  } else {
    // No headings: short quantity-led lines are ingredients, sentences are steps.
    for (const l of lines.slice(out.title ? 1 : 0)) {
      if (looksLikeIngredient(l)) out.ingredients.push(l);
      else if (l.length > 30 && /[.!]$/.test(l)) out.steps.push(stripStepNumber(l));
    }
  }
  // "For the sauce" style sub-headings inside ingredients become sections.
  out.ingredients = out.ingredients.map((l) =>
    /^for the .{2,40}$/i.test(l) && !l.endsWith(':') ? `${l}:` : l);
  return out;
}
