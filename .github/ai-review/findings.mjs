const SEVERITIES = new Set(['P1', 'P2', 'P3']);
const JSON_BLOCK = /```json\s*\n([\s\S]*?)\n\s*```/g;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const path = (value) =>
  text(value)
    .replace(/^\.\//, '')
    .replace(/[\u0000-\u001f]+/g, ' ');
const lineNumber = (value) => (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value);
const reviewers = (value) =>
  Array.isArray(value) ? value.filter((name) => typeof name === 'string' && /^[a-z-]+$/.test(name)) : [];

const absent = (value) => value === null || value === undefined;

function finding(value, index) {
  const onPullRequest = absent(value?.file) && absent(value?.line);
  const line = onPullRequest ? null : lineNumber(value?.line);
  const endLine = lineNumber(value?.end_line);
  const invalid = [
    !SEVERITIES.has(value?.severity) && 'severity',
    !onPullRequest && !path(value?.file) && 'file',
    !onPullRequest && !(Number.isInteger(line) && line > 0) && 'line',
    !text(value?.problem) && 'problem',
    !(typeof value?.confidence === 'number' && value.confidence >= 0 && value.confidence <= 1) && 'confidence',
  ].filter(Boolean);
  if (invalid.length > 0) throw new Error(`finding ${index + 1} has no valid ${invalid.join(', ')}`);
  return {
    severity: value.severity,
    file: onPullRequest ? null : path(value.file),
    line,
    endLine: !onPullRequest && Number.isInteger(endLine) && endLine > line ? endLine : null,
    code: text(value.code),
    title: text(value.title),
    rule: text(value.rule),
    problem: text(value.problem),
    evidence: text(value.evidence),
    fix: text(value.fix),
    confidence: value.confidence,
    foundBy: reviewers(value.found_by),
  };
}

function dropped(value, index) {
  if (!text(value?.reason)) throw new Error(`dropped finding ${index + 1} has no reason`);
  const line = lineNumber(value.line);
  return {
    title: text(value.title),
    file: path(value.file),
    line: Number.isInteger(line) && line > 0 ? line : null,
    reason: text(value.reason),
    foundBy: reviewers(value.found_by),
  };
}

const list = (value, name) => {
  if (!Array.isArray(value)) throw new Error(`"${name}" is not a list`);
  return value;
};

/**
 * The entries of `values` that `read` accepts. Strict, the first entry it refuses throws. Lenient, a refused entry is
 * left out and counted, and when `needsOne` and none is left the first refusal throws.
 */
function entries(values, read, { lenient, needsOne = false }) {
  if (!lenient) return { kept: values.map(read), unread: 0 };
  const errors = [];
  const kept = values.flatMap((value, index) => {
    try {
      return [read(value, index)];
    } catch (error) {
      errors.push(error.message);
      return [];
    }
  });
  if (needsOne && kept.length === 0 && errors.length > 0) throw new Error(errors[0]);
  return { kept, unread: errors.length };
}

/**
 * A reviewer's answer: `{ findings }`. Throws an error naming what is wrong. With `lenient`, a finding that cannot be
 * read is left out instead and `unread` counts them.
 */
export function parseReview(value, { lenient = false } = {}) {
  const { kept, unread } = entries(list(value?.findings, 'findings'), finding, { lenient, needsOne: true });
  return { findings: kept, ...(lenient && { unread }) };
}

/**
 * The merger's answer: `{ summary, findings, dropped }`. Throws an error naming what is wrong. With `lenient`, a
 * finding that cannot be read is left out instead and `unread` counts them.
 */
export function parseMerge(value, { lenient = false } = {}) {
  if (!text(value?.summary)) throw new Error('"summary" is missing');
  const findings = entries(list(value.findings, 'findings'), finding, { lenient, needsOne: true });
  const left = entries(list(value.dropped ?? [], 'dropped'), dropped, { lenient });
  return {
    summary: text(value.summary),
    findings: findings.kept,
    dropped: left.kept,
    ...(lenient && { unread: findings.unread + left.unread }),
  };
}

/** The JSON value an agent ended its answer with: the last fenced `json` block, else the whole answer. */
export function lastJson(answer) {
  const blocks = [...answer.matchAll(JSON_BLOCK)].map((match) => match[1]);
  const candidate = blocks.at(-1) ?? answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error('the answer does not end with a JSON block');
  }
}
