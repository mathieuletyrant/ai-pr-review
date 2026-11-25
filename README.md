# AI PR review

Multi-model AI code review for GitHub pull requests, as a reusable workflow. On every PR:

1. Three [opencode](https://opencode.ai) reviewers run in parallel, each in a checkout of the head commit with the
   dependencies installed and a sandboxed shell (its only network route is OpenRouter):
   - `review-defects` (DeepSeek V4.1 Flash): bugs, edge cases, blast radius
   - `review-standards` (DeepSeek V4.1 Flash): `CODING_STANDARDS.md`, the spec (title and description), the design
   - `review-security` (GLM 5.3 Flash): untrusted input to sink, scoping, secrets
2. `review-merge` (DeepSeek V4.1 Flash) groups duplicates, tries to refute each finding against the code, and ranks
   what survives P1 / P2 / P3.
3. One GitHub review is posted with inline comments, the previous one is collapsed, and a status comment shows the
   run's cost.

Expect about $0.20 per PR.

## Add it to a repo

1. Copy `examples/ai-review.yml` to `<repo>/.github/workflows/ai-review.yml`.
2. Set the `OPENROUTER_API_KEY` secret: `gh secret set OPENROUTER_API_KEY --repo <owner>/<repo>`. Give the key a
   monthly budget on OpenRouter.
3. Optional: a `CODING_STANDARDS.md` at the root (start from this repo's). The reviewers read it whole.
4. Optional, to post as your own bot: a GitHub App (Pull requests read and write, Contents read) installed on the repo,
   with the `AI_REVIEW_APP_ID` and `AI_REVIEW_APP_PRIVATE_KEY` secrets. Without it, reviews post as
   `github-actions[bot]`.

Re-run with a `/ai-review` comment or the `ai-review` label. Skip a PR with the `skip-ai-review` label.

## Update every repo at once

Repos call `review.yml@v1`, and the workflow fetches its scripts and agents at the `kit-ref` input (default `v1`):

```bash
git tag -f v1 && git push -f origin v1
```

To pin a version, use the same sha in `uses: …@<sha>` and `with: kit-ref: <sha>`.

## Settings

| What                 | Where                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| Display name         | input `review-name`                                                                                       |
| Models               | inputs `reviewer-model` / `security-model` / `merger-model`, options in `opencode/opencode.json`          |
| Providers and data   | `opencode/opencode.json` + `openrouter-meter.mjs` (US providers, zero data retention, no data collection) |
| What an agent checks | `.github/ai-review/opencode/agents/*.md`                                                                  |
| Display threshold    | `MIN_CONFIDENCE` in `post-review.mjs` (0.6)                                                               |
| Limits               | `--max-steps` / `--minutes` in the workflow                                                               |

## Nightly self-tuning

A Claude Code routine (`/schedule`), every weekday evening, on this repo (lessons for the agents) or on a project
(lessons for its `CODING_STANDARDS.md`):

> Run the tune-ai-review skill.

It labels each finding of the day (hit / wrong / noise / miss…) against the replies, the commits after it, and the
human and other bot reviews, then opens one PR of general lessons, or none.

## Run it locally

```bash
npm i -g opencode-ai@1.18.34
gh api repos/<owner>/<repo>/pulls/<n> | jq '{pull_request: .}' > /tmp/event.json
git checkout <head sha>
OPENROUTER_API_KEY=… node .github/ai-review/run-agent.mjs --agent review-defects \
  --model openrouter/deepseek/deepseek-v4.1-flash --event /tmp/event.json --out /tmp/defects.json
```

The merger: `--agent review-merge --review defects=/tmp/defects.json --review standards=… --review security=…`.
