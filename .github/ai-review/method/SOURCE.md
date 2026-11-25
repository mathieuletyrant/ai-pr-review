# Source of the review method

`code-review.md` is adapted from [mattpocock/skills](https://github.com/mattpocock/skills), file
`skills/engineering/code-review/SKILL.md` at commit `b0618bc436ad893b3c5e84e55fba86586d34a404`, under the MIT
license in `LICENSE`. The `review-standards` agent reads it.

What changed from the original, because the agents run in CI with the pull request already chosen:

- Removed: pinning the fixed point, finding the spec in the issue tracker, spawning the two sub-agents and
  aggregating their reports. The pull request is `base...head`, its spec is its title and description, and the
  two reviewers and the merger are the workflow's jobs (`../opencode/agents/`).
- Kept: the two axes and "Why two axes" (moved to the top), the smell baseline and its two rules (verbatim), the
  Standards and Spec briefs.
- The standards are the files `CODING_STANDARDS.md` selects; the severity and the answer format are in the agent.

To update: copy the new `SKILL.md`, apply the same removals, and change the commit above.
