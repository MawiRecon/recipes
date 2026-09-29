// Public values — the anon key is designed to live in client code (RLS guards writes).
export const SUPABASE_URL = 'https://xitiuhvucnwtklbljgxh.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_IIv_Wnu8-REOlOdKqfAttg_Wr2WkdWW';

export const PEOPLE = ['Mason', 'Lillian'];

export const TAG_GROUPS = {
  Protein: ['chicken', 'fish', 'seafood', 'beef', 'pork', 'turkey', 'vegetarian', 'vegan'],
  Meal: ['breakfast', 'lunch', 'dinner', 'side', 'snack', 'dessert', 'drink'],
  Effort: ['weeknight', 'meal-prep', 'project'],
  // Custom tags used on any recipe are appended to Type automatically.
  Type: ['salad', 'soup', 'pasta', 'bowl', 'sandwich', 'tacos', 'sheet-pan', 'slow-cooker'],
};
