/**
 * Tampermonkey storage keys. GM storage is shared across every @match context
 * of the same script, which is the whole trick that lets the x.com half hand
 * recipes to the app half without a server.
 */

export const CSRF_KEY = 'x:ct0';

/**
 * Every GraphQL operation name the harvester has ever observed, whether or not
 * we replay it. Purely diagnostic: it is the difference between "we cannot see
 * X's traffic" and "we see it under a name we do not recognise", which are
 * completely different problems.
 */
export const SEEN_KEY = 'x:seen';

const RECIPE_PREFIX = 'x:recipe:';

export function recipeKey(operation: string): string {
  return `${RECIPE_PREFIX}${operation}`;
}

/**
 * Which operations we hold a recipe for, read back from storage rather than
 * from a hardcoded list - that is what lets a renamed operation still be
 * found.
 */
export function storedOperations(): string[] {
  return GM_listValues()
    .filter((key) => key.startsWith(RECIPE_PREFIX))
    .map((key) => key.slice(RECIPE_PREFIX.length))
    .sort();
}

/** Read a JSON string array from storage, tolerating anything malformed. */
export function readStringList(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(GM_getValue(key, '[]'));
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}
