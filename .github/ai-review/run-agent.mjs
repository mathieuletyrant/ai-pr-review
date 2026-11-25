import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { lastJson, parseMerge, parseReview } from './findings.mjs';
import { MAX_TOKENS, meterTotals, startMeter } from './openrouter-meter.mjs';
import { SANDBOX_PORT, sandboxed, stopFileOf } from './sandbox.mjs';

const CONFIG_DIR = fileURLToPath(new URL('opencode/', import.meta.url));
const TOOL_ROOT = fileURLToPath(new URL('./', import.meta.url));
const KILL_GRACE_MS = 5_000;
const FINAL_ANSWER_STEPS = 3;
const FINAL_ANSWER_MS = 5 * 60_000; // 5 min
const AGENT_ENV = {
  OPENCODE_CONFIG_DIR: CONFIG_DIR,
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_SHARE: '1',
};
const WITHHELD_ENV = /^(GH_TOKEN|GITHUB_TOKEN|ACTIONS_[A-Z_]+|OPENROUTER_API_KEY)$/;

const oneLine = (value, length = 160) => String(value).replace(/\s+/g, ' ').slice(0, length);

/**
 * The environment an agent runs in: the job's, without GitHub's tokens or the OpenRouter key, with opencode pointed at
 * this folder's config and at the meter in `baseURL`, which holds the key. `config` is opencode config laid over this
 * folder's, for a variant under evaluation (an agent's `steps`, a model's options); it never moves the meter.
 * `agentsDir` is the opencode config folder to run instead of this one, another commit's for a before and after.
 */
export function agentEnv({ baseURL, env = process.env, config = {}, agentsDir = CONFIG_DIR }) {
  const openrouter = { ...config.provider?.openrouter, options: { baseURL } };
  return {
    ...Object.fromEntries(Object.entries(env).filter(([name]) => !WITHHELD_ENV.test(name))),
    ...AGENT_ENV,
    OPENCODE_CONFIG_DIR: agentsDir,
    OPENROUTER_API_KEY: 'held-by-the-meter',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, provider: { ...config.provider, openrouter } }),
  };
}

const emptyUsage = () => ({
  steps: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cost: 0,
});

function addStep(usage, part) {
  usage.steps += 1;
  usage.inputTokens += part.tokens?.input ?? 0;
  usage.outputTokens += part.tokens?.output ?? 0;
  usage.reasoningTokens += part.tokens?.reasoning ?? 0;
  usage.cacheReadTokens += part.tokens?.cache?.read ?? 0;
  usage.cost += part.cost ?? 0;
}

const unconfined = (command, env) => ({ command, env });

/**
 * How `runOpencode` starts opencode inside the sandbox of `sandbox.mjs`: the agent's environment goes to a file of
 * `dir` the sandbox reads, the command that enters it keeps only the PATH, and `stop` ends the sandbox.
 */
export function sandboxLaunch({ dir, meterSocket, uid = process.getuid(), gid = process.getgid(), isRoot }) {
  return (command, env) => {
    const envFile = join(dir, 'agent-env.json');
    writeFileSync(envFile, JSON.stringify(env), { mode: 0o600 });
    rmSync(stopFileOf(envFile), { force: true });
    return {
      command: sandboxed({ command, envFile, meterSocket, uid, gid, isRoot }),
      env: { PATH: process.env.PATH },
      stop: () => writeFileSync(stopFileOf(envFile), ''),
    };
  };
}

/**
 * Runs `opencode run` and reads its JSON events. It stops the process once `maxSteps` model calls have finished or at
 * `deadline`, since opencode's own step limit only asks the model to stop. Resolves with the session, the text of the
 * last answer, the error opencode reported and the usage.
 */
export function runOpencode({ bin, args, env, maxSteps, deadline, usage, log = console.log, launch = unconfined }) {
  return new Promise((resolve) => {
    const started = launch([bin, 'run', '--format', 'json', ...args], env);
    const child = spawn(started.command[0], started.command.slice(1), {
      env: started.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const outcome = { sessionID: null, answer: '', error: null, stopped: null };
    let answerMessage = null;
    let stderr = '';

    const stop = (reason) => {
      if (outcome.stopped) return;
      outcome.stopped = reason;
      started.stop?.();
      const signal = (name) => {
        try {
          process.kill(-child.pid, name);
        } catch {}
      };
      signal('SIGTERM');
      setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => stop('deadline'), Math.max(0, deadline - Date.now()));

    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2_000)));
    createInterface({ input: child.stdout }).on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      outcome.sessionID ??= event.sessionID ?? null;
      const { part } = event;
      if (event.type === 'text' && part?.text) {
        if (part.messageID !== answerMessage) outcome.answer = '';
        answerMessage = part.messageID;
        outcome.answer += part.text;
      } else if (event.type === 'tool_use' && part) {
        usage.toolCalls += 1;
        const input = part.state?.input ?? {};
        log(`${part.tool}: ${oneLine(input.command ?? input.filePath ?? input.pattern ?? JSON.stringify(input))}`);
      } else if (event.type === 'step_finish' && part) {
        addStep(usage, part);
        if (usage.steps >= maxSteps) stop('steps');
      } else if (event.type === 'error') {
        outcome.error = event.error?.data?.message ?? event.error?.name ?? 'opencode reported an error';
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !outcome.stopped && !outcome.error) {
        outcome.error = `opencode exited with ${code}: ${oneLine(stderr, 500)}`;
      }
      resolve(outcome);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ...outcome, error: error.message });
    });
  });
}

function parseAnswer(answer, parse) {
  try {
    return { result: parse(lastJson(answer)), error: null };
  } catch (error) {
    return { result: null, error: error.message };
  }
}

/**
 * Runs `agent` on `message` and parses its JSON answer with `parse`. When the answer is missing or invalid, or the run
 * was stopped, the same session is asked once for the answer alone. An answer still invalid then keeps the findings
 * that can be read.
 */
export async function runAgent({
  bin,
  agent,
  model,
  message,
  parse,
  maxSteps,
  minutes,
  env,
  log = console.log,
  launch,
}) {
  const started = Date.now();
  const usage = emptyUsage();
  const tagged = (line) => log(`[${agent}] ${line}`);
  const common = ['--agent', agent, '--model', model, '--title', `ai-review ${agent}`];

  const first = await runOpencode({
    bin,
    args: [...common, message],
    env,
    maxSteps,
    deadline: started + minutes * 60_000,
    usage,
    log: tagged,
    launch,
  });
  let parsed = parseAnswer(first.answer, parse);
  let { error } = first;
  const askedAgain = Boolean(!parsed.result && first.sessionID && !error);
  if (askedAgain) {
    const why = first.stopped
      ? `You reached the ${first.stopped === 'steps' ? 'step' : 'time'} limit.`
      : `Your answer could not be read: ${parsed.error}.`;
    if (!first.stopped) {
      tagged(
        `unreadable answer of ${first.answer.length} characters, ending with: ${oneLine(first.answer.slice(-200))}`,
      );
    }
    tagged(`asking for the answer again: ${why}`);
    const retry = await runOpencode({
      bin,
      args: [
        ...common,
        '--session',
        first.sessionID,
        `${why} Stop investigating. Answer now with only the JSON block of the format you were given, holding the findings you have evidence for.`,
      ],
      env,
      maxSteps: usage.steps + FINAL_ANSWER_STEPS,
      deadline: Date.now() + FINAL_ANSWER_MS,
      usage,
      log: tagged,
      launch,
    });
    parsed = parseAnswer(retry.answer, parse);
    error = retry.error;
    if (!parsed.result) {
      const partial = [retry.answer, first.answer]
        .map((answer) => parseAnswer(answer, (value) => parse(value, { lenient: true })))
        .find((one) => one.result);
      if (partial) {
        tagged(
          `${parsed.error}: kept the ${partial.result.findings.length} findings that can be read, left out ${partial.result.unread}`,
        );
        parsed = partial;
      }
    }
  }

  return {
    agent,
    model,
    ok: Boolean(parsed.result),
    error: parsed.result ? null : (error ?? parsed.error),
    result: parsed.result,
    usage,
    seconds: Math.round((Date.now() - started) / 1000),
    stopped: first.stopped,
    askedAgain,
  };
}

/**
 * The merger's answer when the reviewers that answered raised nothing: an empty review naming the reviewers that gave
 * no answer, written without a model. Null when a finding is there to check, or when no reviewer answered.
 */
export function nothingToMerge(reviews) {
  const answered = reviews.filter(({ outcome }) => outcome.ok);
  if (answered.length === 0 || answered.some(({ outcome }) => outcome.result.findings.length > 0)) return null;
  const silent = reviews.filter(({ outcome }) => !outcome.ok).map(({ name }) => name);
  return {
    summary:
      silent.length > 0
        ? `No finding from ${answered.map(({ name }) => name).join(', ')}; ${silent.join(', ')} gave no answer.`
        : 'No reviewer raised a finding.',
    findings: [],
    dropped: [],
  };
}

/**
 * The message every agent starts from: the pull request, the range to review, the changed files, the review's own
 * reference files under `references` (a path from the checkout) and, for the merger, the reviews to merge.
 */
export function pullRequestMessage({
  pullRequest,
  changes,
  references,
  reviews = [],
  shallow = false,
  offline = false,
  suffix = '',
}) {
  const { number, title, body, base, head } = pullRequest;
  return [
    `<pull_request number="${number}" base="${base.sha}" head="${head.sha}">`,
    `<title>${title}</title>`,
    `<description>\n${body?.trim() || '(empty)'}\n</description>`,
    '</pull_request>',
    '',
    `The checkout is at the head commit \`${head.sha}\`, with the dependencies installed. The change under review is \`git diff ${base.sha}...${head.sha}\`.`,
    shallow &&
      `The history is shallow: it holds the commits of the pull request and \`${base.sha}\`, the commit it branched from, so \`git log\` and \`git blame\` stop there.`,
    offline &&
      'The shell has no network: `curl`, `wget` and package downloads fail. Read a vendor in `node_modules/`, never online.',
    '',
    'Changed files:',
    changes.trim() || '(none)',
    '',
    `<references>\nThe review method: ${join(references, 'method/code-review.md')}\nThe design vocabulary: ${join(references, 'references/codebase-design/SKILL.md')}\n</references>`,
    ...reviews.map(({ name, outcome }) =>
      outcome.ok
        ? `\n<findings reviewer="${name}">\n${JSON.stringify(outcome.result.findings, null, 1)}\n</findings>`
        : `\n<findings reviewer="${name}" failed="${oneLine(outcome.error ?? 'no answer', 200)}"></findings>`,
    ),
    suffix !== '' && `\n${suffix}`,
  ]
    .filter((line) => line !== false)
    .join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      agent: { type: 'string' },
      model: { type: 'string' },
      out: { type: 'string' },
      event: { type: 'string', default: process.env.GITHUB_EVENT_PATH },
      review: { type: 'string', multiple: true, default: [] },
      'max-steps': { type: 'string', default: '70' },
      minutes: { type: 'string', default: '15' },
      tag: { type: 'string', default: 'review' },
      'only-when-empty': { type: 'boolean', default: false },
      sandbox: { type: 'boolean', default: false },
      config: { type: 'string', default: '{}' },
      suffix: { type: 'string', default: '' },
      providers: { type: 'string', default: '' },
      'agents-dir': { type: 'string' },
    },
  });
  const { agent, model, out } = values;
  if (!agent || !model || !out || !values.event) {
    throw new Error(
      'Usage: run-agent.mjs --agent <name> --model <provider/model> --out <file> [--event <file>] [--review name=file] [--sandbox]',
    );
  }
  const write = (outcome) => writeFileSync(out, `${JSON.stringify(outcome, null, 2)}\n`);
  const reviews = values.review.map((entry) => {
    const [name, file] = entry.split('=');
    const outcome = existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf8'))
      : { ok: false, error: 'the job left no answer' };
    return { name, outcome };
  });

  const empty = reviews.length > 0 ? nothingToMerge(reviews) : null;
  if (empty) {
    console.log(`${agent}: ${empty.summary} Merged without a model.`);
    write({ agent, model, ok: true, error: null, result: empty, usage: emptyUsage(), seconds: 0, stopped: null });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'merged=true\n');
    return;
  }
  if (values['only-when-empty']) return;
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('::warning::OPENROUTER_API_KEY is not set: no AI review.');
    write({ agent, model, ok: false, skipped: true, error: 'OPENROUTER_API_KEY is not set' });
    return;
  }
  if (reviews.length > 0 && reviews.every(({ outcome }) => !outcome.ok)) {
    console.log('::warning::Every reviewer failed: nothing to merge.');
    write({ agent, model, ok: false, error: 'every reviewer failed' });
    return;
  }

  const pullRequest = JSON.parse(readFileSync(values.event, 'utf8')).pull_request;
  const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const changes = git(['diff', '--name-status', '--find-renames', `${pullRequest.base.sha}...${pullRequest.head.sha}`]);
  const shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true';

  const sandboxDir = values.sandbox ? mkdtempSync(join(tmpdir(), 'ai-review-')) : null;
  const meter = await startMeter({
    apiKey: process.env.OPENROUTER_API_KEY,
    user: `${values.tag} #${pullRequest.number} ${agent}`,
    socket: sandboxDir && join(sandboxDir, 'meter.sock'),
    order: values.providers ? values.providers.split(',') : null,
  });
  const run = await runAgent({
    bin: process.env.OPENCODE_BIN ?? 'opencode',
    agent,
    model,
    message: pullRequestMessage({
      pullRequest,
      changes,
      references: relative(process.cwd(), TOOL_ROOT),
      reviews,
      shallow,
      offline: values.sandbox,
      suffix: values.suffix,
    }),
    parse: reviews.length > 0 ? parseMerge : parseReview,
    maxSteps: Number(values['max-steps']),
    minutes: Number(values.minutes),
    env: agentEnv({
      baseURL: sandboxDir ? `http://127.0.0.1:${SANDBOX_PORT}/api/v1` : meter.url,
      config: JSON.parse(values.config),
      agentsDir: values['agents-dir'] ? resolve(values['agents-dir']) : undefined,
    }),
    launch: sandboxDir ? sandboxLaunch({ dir: sandboxDir, meterSocket: meter.socket }) : undefined,
  });
  await meter.close();
  const billed = meterTotals(meter.calls);
  const outcome = {
    ...run,
    usage: { ...run.usage, cost: billed.cost, estimatedCost: run.usage.cost, cutAnswers: billed.cut },
    providers: billed.providers,
  };
  write(outcome);
  const { usage } = outcome;
  console.log(
    `${agent} on ${model}: ${outcome.ok ? 'answered' : `failed (${outcome.error})`} in ${outcome.seconds} s, ${usage.steps} steps, ${usage.toolCalls} tool calls, ${usage.inputTokens + usage.cacheReadTokens} input tokens (${usage.cacheReadTokens} cached), ${usage.outputTokens} output, $${usage.cost.toFixed(4)} billed by OpenRouter (${billed.calls} calls: ${JSON.stringify(billed.providers)}).`,
  );
  if (billed.cut > 0) console.log(`::notice::${agent}: ${billed.cut} answers cut at the ${MAX_TOKENS} token limit.`);
  if (!outcome.ok) console.log(`::warning::${agent} gave no review: ${outcome.error}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.log(`::error::${error.message}`);
    process.exit(1);
  });
}
