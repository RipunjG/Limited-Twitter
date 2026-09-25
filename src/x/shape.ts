/**
 * Summarises a payload's *structure* - keys and value types, not values.
 *
 * When the parser reads nothing, the only way to fix it is to see what X
 * actually returned. Sending the raw response would mean sending the contents
 * of someone's feed, so this keeps the skeleton and discards the content. The
 * discriminator fields are preserved verbatim because they are the structure:
 * without `__typename` and friends the skeleton says nothing useful.
 */

const KEEP_VALUE = new Set([
  '__typename',
  'type',
  'entryType',
  'itemType',
  'cursorType',
  'displayType',
  'instructionType',
]);

/** Truncation limits, to keep a shape small enough to paste into a message. */
const MAX_KEYS = 40;
const MAX_ARRAY_SAMPLES = 2;

export function describeShape(value: unknown, depth = 0, maxDepth = 10): unknown {
  const MAX_DEPTH = maxDepth;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  if (Array.isArray(value)) {
    if (value.length === 0) return 'Array(0)';
    if (depth >= MAX_DEPTH) return `Array(${value.length})`;

    // Sample a couple of elements: timeline arrays are homogeneous apart from
    // the trailing cursor entries, which are exactly what we want to see.
    const samples = [
      ...new Set(
        value
          .slice(0, MAX_ARRAY_SAMPLES)
          .concat(value.length > MAX_ARRAY_SAMPLES ? [value[value.length - 1]] : [])
          .map((item) => JSON.stringify(describeShape(item, depth + 1, maxDepth))),
      ),
    ].map((json) => JSON.parse(json) as unknown);

    return { [`Array(${value.length})`]: samples.length === 1 ? samples[0] : samples };
  }

  if (typeof value !== 'object') return typeof value;
  if (depth >= MAX_DEPTH) return 'object';

  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};

  for (const [key, child] of entries.slice(0, MAX_KEYS)) {
    out[key] =
      KEEP_VALUE.has(key) && typeof child === 'string'
        ? child
        : describeShape(child, depth + 1, maxDepth);
  }
  if (entries.length > MAX_KEYS) out['…'] = `${entries.length - MAX_KEYS} more keys`;

  return out;
}

/**
 * The structure of the last timeline response we failed to read anything from.
 * Held in memory only - it is a debugging aid, not state worth persisting.
 */
let lastUnreadableShape: { operation: string; shape: unknown; at: number } | null = null;

/**
 * Locate the timeline entries, wherever they are nested.
 *
 * Reporting the whole payload from the root wastes the depth budget on eight
 * levels of wrapper and truncates exactly where the interesting part starts -
 * which is what happened the first time this diagnostic was used.
 */
function findEntries(node: unknown, depth = 0): unknown[] | null {
  if (depth > 12) return null;

  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findEntries(child, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object' || node === null) return null;
  const record = node as Record<string, unknown>;

  if (Array.isArray(record.entries) && record.entries.length > 0) {
    return record.entries as unknown[];
  }

  for (const value of Object.values(record)) {
    const found = findEntries(value, depth + 1);
    if (found) return found;
  }
  return null;
}

export function recordUnreadable(operation: string, payload: unknown): void {
  const entries = findEntries(payload);

  // Entries found: spend the whole depth budget on a couple of them, which is
  // where any parsing problem actually lives.
  const shape = entries
    ? {
        note: `${entries.length} entries found; showing the shape of the first few`,
        entries: describeShape(entries.slice(0, 3), 0, 22),
      }
    : describeShape(payload, 0, 14);

  lastUnreadableShape = { operation, shape, at: Date.now() };
}

export function getLastUnreadable(): typeof lastUnreadableShape {
  return lastUnreadableShape;
}

export function clearUnreadable(): void {
  lastUnreadableShape = null;
}
