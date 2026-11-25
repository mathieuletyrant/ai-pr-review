const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The lines of the file after the change that a review comment can target, the added and context lines of a hunk, each
 * with its text.
 */
export function commentableLines(patch) {
  const lines = new Map();
  let newLine = null;
  for (const text of patch.split('\n')) {
    const header = text.match(HUNK_HEADER);
    if (header) newLine = Number(header[1]);
    else if (newLine !== null && (text.startsWith('+') || text.startsWith(' '))) lines.set(newLine++, text.slice(1));
  }
  return lines;
}
