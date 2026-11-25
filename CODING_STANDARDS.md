# Coding standards

The AI reviewers read this file whole. Keep it short, true and specific to this repo: every rule here is applied to
every pull request.

## Reviewing a diff

1. Read the title and the description: they are the spec.
2. Read the diff, then the whole file around each hunk, then the callers of what changed.
3. Apply the rules below, then "Before you flag".

## Before you flag

A finding that matches one of these is dropped.

- **Intent.** Behaviour the description, an issue or an ADR asks for is the spec, not a bug.
- **Premise.** A claim about a library, the platform or the data is checked against the installed version's source
  (`node_modules/<pkg>`) first.
- **Path.** A finding about an impossible-looking state names the caller or input that reaches it.
- **Scope.** A gap the diff does not touch is pre-existing. Code the diff leaves behaviourally as it was is not renamed,
  extracted or deleted by this PR.
- **Tooling.** What the linter, the formatter or the type checker reports on its own is no finding.
- **Accepted risk.** A race or a ceiling recorded in an ADR or a `ponytail:` comment stays, unless one conditional write
  closes it.

A security finding stays a finding even when an earlier reply waved the same class away.

## Rules for every diff

### Names

- A name says what the thing is or does, with no abbreviation the reader must guess.

### Tests

- A bug fix holds a test that fails without it.
- A test asserts the result of what it runs.

### Comments

No comment that explains, justifies or narrates the code: the why goes in the commit or the PR. Allowed: a comment that
prevents a concrete foot-gun, a unit on a numeric literal, a vendor quirk with its link, a `TODO` with an issue, JSDoc
on an exported contract.

### Security

- Every read and write is scoped by the session's user or tenant in the query itself, never by an id the client sends.
- No secret in code, logs or error messages.
