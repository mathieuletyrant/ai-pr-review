import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { createGitHub } from './github.mjs';
import { buildReview, liveReviews, neutralize, publishReview, reportableFindings } from './post-review.mjs';

const REVIEW_NAME = process.env.AI_REVIEW_NAME || 'AI';

const MERGER = 'review-merge';

const report = (markdown) => {
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
};

const runUrlOf = ({ GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID }) =>
  GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : null;
const totalCost = (runs) => runs.reduce((sum, run) => sum + (run.usage?.cost ?? 0), 0);
const where = ({ file, line }) =>
  file ? `\`${file.replaceAll('`', '')}${line ? `:${line}` : ''}\`` : 'the pull request';
const reviewers = (names) => (names.length > 0 ? `, found by ${names.join(' and ')}` : '');

/** The reviewers that ran and gave no answer, by the name their findings carry: `defects`, `standards`, `security`. */
export const silentReviewers = (runs) =>
  runs.filter((run) => run.agent !== MERGER && !run.ok && !run.skipped).map((run) => run.agent.replace(/^review-/, ''));

const summaryRow = (run) =>
  run.usage
    ? `| \`${run.agent}\` | \`${run.model}\` | ${run.ok ? 'answered' : run.error} | ${run.seconds} s | ${run.usage.steps} | ${run.usage.toolCalls} | ${run.usage.inputTokens + run.usage.cacheReadTokens} | ${run.usage.cacheReadTokens} | ${run.usage.outputTokens} | $${run.usage.cost.toFixed(4)} |`
    : `| \`${run.agent}\` | \`${run.model}\` | ${run.error} | | | | | | | |`;

/**
 * The files of the reviewed range with their patch: the pull request's own list (up to 3000 files) while its head is
 * the reviewed one, else the comparison of the range (up to 300), since a push during the run moved the pull request.
 */
async function reviewedFiles({ github, pullNumber, baseSha, headSha }) {
  const pull = await github.request('GET', `/pulls/${pullNumber}`);
  if (pull.head.sha === headSha) return github.paginate(`/pulls/${pullNumber}/files`);
  return (await github.request('GET', `/compare/${baseSha}...${headSha}`)).files ?? [];
}

/**
 * Posts the merger's review on the pull request and collapses the earlier AI review `author` posted, the bot whose
 * token `github` holds. `runs` are the outcomes `run-agent.mjs` wrote, the merger's among them. The comments sit on the
 * diff of the reviewed range; the body links `runUrl`, whose job summary lists what the merger kept and dropped.
 * Returns the URL of the posted review, or null when there is nothing to post.
 */
export async function postMergedReview({ github, pullNumber, baseSha, headSha, runs, author, runUrl }) {
  const merge = runs.find((run) => run.agent === MERGER);
  if (!merge?.ok) return null;
  const prFiles = await reviewedFiles({ github, pullNumber, baseSha, headSha });
  const review = buildReview({ merge: merge.result, prFiles, headSha, runUrl, silent: silentReviewers(runs) });
  const earlier = await liveReviews({ github, pullNumber, author });
  return (await publishReview({ github, pullNumber, headSha, review, earlier, author })).html_url;
}

/**
 * What the run did, for the job summary: the merger's summary, every finding it kept with its confidence and reviewers,
 * the ones it dropped with its reason, and each agent's time, tokens and cost.
 */
export function jobSummary({ headSha, url, runs }) {
  const merge = runs.find((run) => run.agent === MERGER)?.result;
  const shown = new Set(merge ? reportableFindings(merge.findings) : []);
  return [
    `### ${REVIEW_NAME} review of \`${headSha.slice(0, 7)}\`: ${url ? `[posted](${url})` : 'nothing posted'}`,
    merge && neutralize(merge.summary),
    merge?.findings.length > 0 &&
      [
        `**Kept by the merger (${merge.findings.length})**`,
        '',
        ...merge.findings.map(
          (finding) =>
            `- ${finding.severity} ${where(finding)} ${neutralize(finding.title)} (confidence ${finding.confidence.toFixed(2)}${reviewers(finding.foundBy)})${shown.has(finding) ? '' : ', not shown'}`,
        ),
      ].join('\n'),
    merge?.dropped.length > 0 &&
      [
        `**Dropped by the merger (${merge.dropped.length})**`,
        '',
        ...merge.dropped.map(
          (finding) =>
            `- ${where(finding)} ${neutralize(finding.title)}${reviewers(finding.foundBy)}: ${neutralize(finding.reason)}`,
        ),
      ].join('\n'),
    [
      '| Agent | Model | Outcome | Time | Steps | Tool calls | Input tokens | Cached | Output tokens | Cost |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...runs.map(summaryRow),
    ].join('\n'),
    `$${totalCost(runs).toFixed(4)} in all, billed by OpenRouter.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      runs: { type: 'string' },
      event: { type: 'string', default: process.env.GITHUB_EVENT_PATH },
    },
  });
  if (!values.runs || !values.event) throw new Error('Usage: post.mjs --runs <directory> [--event <file>]');
  const { pull_request: pullRequest } = JSON.parse(readFileSync(values.event, 'utf8'));
  const { number, base, head } = pullRequest;
  const runs = readdirSync(values.runs)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(values.runs, name), 'utf8')));

  const github = createGitHub({ repo: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN });
  const url = await postMergedReview({
    github,
    pullNumber: number,
    baseSha: base.sha,
    headSha: head.sha,
    runs,
    author: process.env.AI_REVIEW_BOT ?? 'github-actions[bot]',
    runUrl: runUrlOf(process.env),
  });
  report(jobSummary({ headSha: head.sha, url, runs }));
  if (url) {
    const findings = reportableFindings(runs.find((run) => run.agent === MERGER).result.findings).length;
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `review-url=${url}\nfindings=${findings}\ncost=${totalCost(runs).toFixed(4)}\n`,
      );
    }
    return;
  }
  const merge = runs.find((run) => run.agent === MERGER);
  if (merge?.skipped) return;
  console.log(`::error::No AI review posted: ${merge ? merge.error : 'the merger left no answer'}.`);
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.log(`::error::${error.message}`);
    process.exit(1);
  });
}
