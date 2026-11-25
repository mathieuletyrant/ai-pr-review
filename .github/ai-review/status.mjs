import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { createGitHub } from './github.mjs';

const REVIEW_NAME = process.env.AI_REVIEW_NAME || 'AI';

const MARKER = 'ai-review-status:v1';
const STATE = new RegExp(`<!-- ${MARKER} (\\{.*?\\}) -->`);
const STATES = ['running', 'completed', 'failed', 'cancelled'];

const PULL_REQUEST_TRIGGERS = {
  opened: 'the pull request opened',
  ready_for_review: 'the pull request marked ready',
  reopened: 'the pull request reopened',
  labeled: 'the `ai-review` label',
};

/** What started the run, in words, from the event the workflow received. */
export function triggerOf(eventName, event) {
  if (eventName === 'issue_comment') {
    return event.comment?.body?.startsWith('/ai-review') ? 'a `/ai-review` comment' : 'an `@codex` comment';
  }
  return PULL_REQUEST_TRIGGERS[event.action] ?? 'the pull request';
}

const plural = (count) => (count === 1 ? '1 finding' : `${count} findings`);

function headline({ state, findings, reviewUrl, cost }) {
  if (state === 'running') return '⏳ Running';
  if (state === 'cancelled') return '⚪ Cancelled';
  if (state === 'failed') return '❌ Failed, no review posted';
  const review = findings > 0 ? `[${plural(findings)}](${reviewUrl})` : `[no finding](${reviewUrl})`;
  return `✅ Completed, ${review}${cost ? ` · $${cost} billed by OpenRouter` : ''}`;
}

function renderStatus(status) {
  const { state, runId, headSha, runUrl, trigger } = status;
  return [
    `<!-- ${MARKER} ${JSON.stringify({ runId, headSha, state })} -->`,
    `**${REVIEW_NAME} review**: ${headline(status)}`,
    `On \`${headSha.slice(0, 7)}\`, started by ${trigger}. [The run](${runUrl}). A \`/ai-review\` comment runs it again.`,
  ].join('\n\n');
}

/**
 * Writes the run's state in the one status comment `author` keeps on the pull request: creates it on the first run,
 * edits it after, and leaves it to a newer run that already wrote it, so a cancelled run never overwrites the run that
 * replaced it. `status` is `{ state, runId, headSha, runUrl, trigger }`, plus `findings`, `reviewUrl` and `cost` (the
 * dollars OpenRouter billed, as text) once completed. Returns what it did: `created`, `updated` or `kept`.
 */
export async function setStatus({ github, pullNumber, author, status }) {
  if (!STATES.includes(status.state)) throw new Error(`Unknown review state: ${status.state}`);
  const comments = await github.paginate(`/issues/${pullNumber}/comments`);
  const current = comments.find((comment) => comment.user?.login === author && STATE.test(comment.body ?? ''));
  const body = renderStatus(status);
  if (!current) {
    await github.request('POST', `/issues/${pullNumber}/comments`, { body });
    return 'created';
  }
  if (JSON.parse(STATE.exec(current.body)[1]).runId > status.runId) return 'kept';
  await github.request('PATCH', `/issues/comments/${current.id}`, { body });
  return 'updated';
}

async function main() {
  const { values } = parseArgs({
    options: {
      state: { type: 'string' },
      event: { type: 'string' },
      findings: { type: 'string', default: '0' },
      'review-url': { type: 'string', default: '' },
      cost: { type: 'string', default: '' },
    },
  });
  if (!values.state || !values.event) {
    throw new Error(
      'Usage: status.mjs --state <state> --event <file> [--findings <n>] [--review-url <url>] [--cost <dollars>]',
    );
  }
  const { GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SERVER_URL, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH } = process.env;
  const { number, head } = JSON.parse(readFileSync(values.event, 'utf8')).pull_request;
  const trigger = triggerOf(GITHUB_EVENT_NAME, JSON.parse(readFileSync(GITHUB_EVENT_PATH, 'utf8')));
  const done = await setStatus({
    github: createGitHub({ repo: GITHUB_REPOSITORY, token: process.env.GH_TOKEN }),
    pullNumber: number,
    author: process.env.AI_REVIEW_BOT ?? 'github-actions[bot]',
    status: {
      state: values.state,
      runId: Number(GITHUB_RUN_ID),
      headSha: head.sha,
      runUrl: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`,
      trigger,
      findings: Number(values.findings),
      reviewUrl: values['review-url'],
      cost: values.cost,
    },
  });
  console.log(`${REVIEW_NAME} status ${values.state}: ${done}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.log(`::warning::${REVIEW_NAME} status not written: ${error.message}`);
  });
}
