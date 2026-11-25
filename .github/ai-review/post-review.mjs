import { commentableLines } from './diff.mjs';

const REVIEW_NAME = process.env.AI_REVIEW_NAME || 'AI';

const MARKER = '<!-- ai-review -->';
const FINDING_TAG = 'ai-review-finding:v1';
/** The confidence under which the review does not show a finding. */
export const MIN_CONFIDENCE = 0.6;
const SEVERITY_RANK = { P1: 0, P2: 1, P3: 2 };
const MINIMIZE_COMMENT = `mutation($id: ID!) {
  minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { minimizedComment { isMinimized } }
}`;

const MIN_QUOTE = 6;
const BADGE_COLOR = { P1: 'orange', P2: 'yellow', P3: 'blue' };
const badge = (severity) =>
  `<sub><sub>![${severity} Badge](https://img.shields.io/badge/${severity}-${BADGE_COLOR[severity]}?style=flat)</sub></sub>`;
const about = (runUrl) =>
  [
    '<details><summary>About this review</summary>',
    '',
    'Three agents reviewed the change on their own, for defects, for the standards and the design, and for security; a fourth checked each finding against the code and kept what it confirmed. Not a required check. Reply on a finding that is wrong, saying why: the daily tuning of the review reads the replies. Comment `/ai-review`, or mention `@codex`, to run it again; the `skip-ai-review` label turns it off for this pull request, except on a `/ai-review` comment.',
    runUrl && `[This run](${runUrl}) lists the findings the merger kept and the ones it dropped.`,
    '</details>',
  ]
    .filter(Boolean)
    .join('\n');

const RUN_LINK = /\[This run\]\((https:\/\/[^\s()]+\/actions\/runs\/\d+)\)/g;
const shortSha = (sha) => sha.slice(0, 7);
const CODE_SPAN = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
const PATH =
  /(?<![\w./`-])(?<!\]\()(?:(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]\w{0,4}|[\w.-]+\.[A-Za-z]\w{0,4}(?=:\d))(?::\d+(?:-\d+)?)?(?![\w/])/g;
const clean = (text) =>
  text
    .replaceAll('![', '[')
    .replaceAll('<', '&lt;')
    .replace(/@(?=[\w-])/g, '@​')
    .replace(PATH, '`$&`');

/**
 * Model text with images, HTML and @mentions neutralized outside code spans, its file paths and `path:line` set as
 * code, and no applicable suggestion block.
 */
export function neutralize(text) {
  const safe = String(text).replace(/```\s*suggestion/gi, '```text');
  let result = '';
  let end = 0;
  for (const span of safe.matchAll(CODE_SPAN)) {
    result += clean(safe.slice(end, span.index)) + span[0];
    end = span.index + span[0].length;
  }
  return result + clean(safe.slice(end));
}

const squash = (text) => text.replace(/\s+/g, ' ').trim();
const onPullRequest = (finding) => finding.file === null;
const location = ({ file, line, endLine }) => `\`${file.replaceAll('`', '')}:${line}${endLine ? `-${endLine}` : ''}\``;

function findingText(finding, where = '') {
  return [
    `**${badge(finding.severity)}  ${neutralize(finding.title || finding.rule || 'Finding')}**${where}`,
    neutralize(finding.problem),
    finding.fix && neutralize(finding.fix),
    finding.evidence && `<details><summary>Evidence</summary>\n\n${neutralize(finding.evidence)}\n</details>`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The hidden line an inline finding ends with: its severity, its confidence and the reviewers that raised it, for the
 * scripts that count what became of it.
 */
export const findingTag = ({ severity, confidence, foundBy }) =>
  `<!-- ${FINDING_TAG} ${JSON.stringify({ severity, confidence, by: foundBy })} -->`;

const silentLine = (silent) =>
  `${silent.map((name) => `\`${name}\``).join(' and ')} gave no answer: this review does not cover ${silent.length > 1 ? 'them' : 'it'}.`;

/** The findings at the confidence the review shows, the most severe first. */
export function reportableFindings(findings) {
  return findings
    .filter((finding) => finding.severity in SEVERITY_RANK && finding.confidence >= MIN_CONFIDENCE)
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        (a.file ?? '').localeCompare(b.file ?? '') ||
        (a.line ?? 0) - (b.line ?? 0),
    );
}

/**
 * The lines of GitHub's diff a finding's comment sits on: its own when the diff shows them, moved to the nearest diff
 * line holding the code it quotes when its line does not, null when the diff shows neither. A range the diff does not
 * show whole shrinks to its first line.
 */
export function anchor(finding, diffLines) {
  if (!diffLines) return null;
  const quote = squash(finding.code);
  const quotes = (line) => quote.length >= MIN_QUOTE && squash(diffLines.get(line) ?? '').includes(quote);
  let start = finding.line;
  if (quote.length >= MIN_QUOTE && !quotes(start)) {
    const nearest = [...diffLines.keys()]
      .filter(quotes)
      .sort((a, b) => Math.abs(a - finding.line) - Math.abs(b - finding.line))[0];
    if (nearest !== undefined) start = nearest;
  }
  if (!diffLines.has(start)) return null;
  const end = finding.endLine ? start + finding.endLine - finding.line : start;
  for (let line = start; line <= end; line++) if (!diffLines.has(line)) return { line: start };
  return end > start ? { startLine: start, line: end } : { line: start };
}

function renderBody({ headSha, listed, shown, runUrl, silent }) {
  const general = listed.filter(onPullRequest);
  const located = listed.filter((finding) => !onPullRequest(finding));
  return [
    MARKER,
    `### 🔍 ${REVIEW_NAME} review of \`${shortSha(headSha)}\``,
    shown.length === 0 && 'No finding.',
    silent.length > 0 && silentLine(silent),
    general.length > 0 && ['**On the pull request**', ...general.map((finding) => findingText(finding))].join('\n\n'),
    located.length > 0 &&
      [
        '**On lines outside the diff**',
        ...located.map((finding) => findingText(finding, ` · ${location(finding)}`)),
      ].join('\n\n'),
    about(runUrl),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The review to post from the merger's answer: each finding inline on the lines it is about when GitHub's diff of the
 * pull request shows them, in the body otherwise, a finding about the pull request itself always in the body.
 * `fallbackBody` lists every finding in the body, for when GitHub refuses an inline line. `silent` names the reviewers
 * that gave no answer, which the body says.
 */
export function buildReview({ merge, prFiles, headSha, runUrl, silent = [] }) {
  const diff = new Map(prFiles.map((file) => [file.filename, commentableLines(file.patch ?? '')]));
  const shown = reportableFindings(merge.findings);
  const anchored = shown.map((finding) => ({ finding, at: anchor(finding, diff.get(finding.file)) }));
  const inline = anchored.filter(({ at }) => at);
  const outside = anchored.filter(({ at }) => !at).map(({ finding }) => finding);
  return {
    body: renderBody({ headSha, listed: outside, shown, runUrl, silent }),
    fallbackBody: renderBody({ headSha, listed: shown, shown, runUrl, silent }),
    comments: inline.map(({ finding, at }) => ({
      path: finding.file,
      ...(at.startLine && { start_line: at.startLine, start_side: 'RIGHT' }),
      line: at.line,
      side: 'RIGHT',
      body: `${findingText(finding)}\n\n${MARKER}\n${findingTag(finding)}`,
    })),
  };
}

/**
 * The AI reviews `author` posted on the pull request, not superseded yet, each with the URL of its run: the last
 * `[This run]` link of its body, the About's, which no model text follows.
 */
export async function liveReviews({ github, pullNumber, author }) {
  return (await github.paginate(`/pulls/${pullNumber}/reviews`))
    .filter((posted) => posted.user?.login === author && posted.body?.includes(MARKER))
    .map((posted) => ({
      id: posted.id,
      url: posted.html_url,
      commit: posted.commit_id,
      run: [...posted.body.matchAll(RUN_LINK)].at(-1)?.[1] ?? null,
    }));
}

/**
 * Posts `review` on the head commit, then collapses the `earlier` live reviews: their inline comments minimized as
 * outdated, their body a link to the new one and to their own run. When GitHub answers the post with a 5xx, or the
 * answer never arrives, the review it may have created all the same is looked for (a live review of `author` on `headSha` that `earlier` does not hold)
 * before it is posted once more.
 */
export async function publishReview({ github, pullNumber, headSha, review, earlier, author, retryDelayMs = 5_000 }) {
  const create = (body, comments) =>
    github.request('POST', `/pulls/${pullNumber}/reviews`, { commit_id: headSha, event: 'COMMENT', body, comments });
  const createOrRecover = async (body, comments) => {
    try {
      return await create(body, comments);
    } catch (error) {
      if (error.status < 500) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      const known = new Set(earlier.map((old) => old.id));
      const landed = (await liveReviews({ github, pullNumber, author })).find(
        (live) => !known.has(live.id) && live.commit === headSha,
      );
      return landed ? { id: landed.id, html_url: landed.url } : create(body, comments);
    }
  };

  let posted;
  try {
    posted = await createOrRecover(review.body, review.comments);
  } catch (error) {
    if (error.status !== 422 || review.comments.length === 0) throw error;
    posted = await createOrRecover(review.fallbackBody, []);
  }

  for (const old of earlier) {
    try {
      for (const comment of await github.paginate(`/pulls/${pullNumber}/reviews/${old.id}/comments`)) {
        await github.graphql(MINIMIZE_COMMENT, { id: comment.node_id });
      }
    } catch (error) {
      console.log(`::warning::The inline comments of review ${old.id} stay visible: ${error.message}`);
    }
    const superseded = `Superseded by the [${REVIEW_NAME} review of \`${shortSha(headSha)}\`](${posted.html_url}).`;
    await github.request('PUT', `/pulls/${pullNumber}/reviews/${old.id}`, {
      body: old.run ? `${superseded} [Its run](${old.run}) lists what its merger kept and dropped.` : superseded,
    });
  }
  return posted;
}
