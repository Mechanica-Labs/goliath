/**
 * Snapshot windowing -- truncate large accessibility snapshots while
 * preserving pagination/navigation links at the tail.
 */

const MAX_SNAPSHOT_CHARS = 80000;  // ~20K tokens
const SNAPSHOT_TAIL_CHARS = 5000;  // keep last ~5K for pagination/nav links

/**
 * Return a window of the snapshot YAML.
 *  offset=0 (default): head chunk + tail (pagination/nav).
 *  offset=N: chars N..N+budget from the full snapshot.
 *  Always appends pagination tail so nav refs are available in every chunk.
 */
function windowSnapshot(yaml, offset = 0, maxChars = MAX_SNAPSHOT_CHARS) {
  if (!yaml) return { text: '', truncated: false, totalChars: 0, offset: 0 };
  const total = yaml.length;
  if (total <= maxChars) return { text: yaml, truncated: false, totalChars: total, offset: 0 };

  const tailChars = Math.min(SNAPSHOT_TAIL_CHARS, Math.floor(maxChars / 4));
  const contentBudget = maxChars - tailChars - 200; // room for marker
  const tail = yaml.slice(-tailChars);
  const clampedOffset = Math.min(Math.max(0, offset), total - tailChars);
  const chunk = yaml.slice(clampedOffset, clampedOffset + contentBudget);
  const chunkEnd = clampedOffset + contentBudget;
  const hasMore = chunkEnd < total - tailChars;

  const marker = hasMore
    ? `\n[... truncated at char ${chunkEnd} of ${total}. Call snapshot with offset=${chunkEnd} to see more. Pagination links below. ...]\n`
    : '\n';

  return {
    text: chunk + marker + tail,
    truncated: true,
    totalChars: total,
    offset: clampedOffset,
    hasMore,
    nextOffset: hasMore ? chunkEnd : null
  };
}

const MIN_SNAPSHOT_WINDOW_CHARS = 2000;

/**
 * Clamp a caller-supplied per-request window budget. Invalid or missing values
 * fall back to the default cap so existing callers are unaffected.
 */
function clampSnapshotWindow(value) {
  const parsed = parseInt(value, 10);
  if (!Number.isInteger(parsed)) return MAX_SNAPSHOT_CHARS;
  return Math.min(Math.max(parsed, MIN_SNAPSHOT_WINDOW_CHARS), MAX_SNAPSHOT_CHARS);
}

/**
 * Reduce a snapshot to what an agent can act on: lines carrying an element
 * ref, iframe boundary markers, headings for orientation, and the indentation
 * ancestors of every kept line so tree context survives. Text-only content
 * (paragraphs, list prose, generic containers) is dropped. Refs are unchanged
 * -- they are resolved against the live tab state, not the returned text.
 */
const INTERACTIVE_LINE = /\[e\d+\]/;
const STRUCTURAL_LINE = /\[frame-key=|^\s*-\s+heading\b/;

function filterInteractive(yaml) {
  if (!yaml) return { text: '', fullChars: 0, keptLines: 0, totalLines: 0 };
  const lines = yaml.split('\n');
  const keep = new Array(lines.length).fill(false);
  const stack = []; // open ancestors as {indent, index}
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const indent = line.length - line.trimStart().length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (INTERACTIVE_LINE.test(line) || STRUCTURAL_LINE.test(line)) {
      keep[index] = true;
      for (const ancestor of stack) keep[ancestor.index] = true;
    }
    stack.push({ indent, index });
  });
  const kept = lines.filter((_, index) => keep[index]);
  return {
    text: kept.join('\n'),
    fullChars: yaml.length,
    keptLines: kept.length,
    totalLines: lines.length,
  };
}

export { windowSnapshot, filterInteractive, clampSnapshotWindow, MAX_SNAPSHOT_CHARS, SNAPSHOT_TAIL_CHARS, MIN_SNAPSHOT_WINDOW_CHARS };
