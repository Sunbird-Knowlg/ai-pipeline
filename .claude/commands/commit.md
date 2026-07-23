---
description: Create a Conventional Commits git commit for the current changes
argument-hint: "[optional message hint]"
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*)
---

You are creating a git commit for **ai-pipeline** (Python monorepo, PyFlink jobs). Extra hint from the user (may be empty): $ARGUMENTS

## Pre-loaded context

Status:
!`git status --porcelain=v1 -b`

Staged diff:
!`git diff --staged`

Recent commit style (mirror it):
!`git log --oneline -12`

## Steps

1. Analyze the changes above and determine the commit **type** and **scope**.
2. If **nothing is staged**, propose the files to stage and **ask the user before running `git add`**. Never stage secrets (`.env*`, `*.pem`, `*.key`, any real API keys/connection strings).
3. Present the proposed commit message and **wait for confirmation before committing**.
4. Create the commit with `git commit`.

## Commit Message Format

```
{type}({scope}): {short description}

{optional body — only if the change needs explanation}
```

### Types
- `feat` — new feature or pipeline capability
- `fix` — bug fix
- `refactor` — code restructure without behavior change
- `test` — adding or fixing tests
- `chore` — build, Makefile, Docker, dependency changes
- `docs` — documentation only (README, `docs/`, `.claude/`)

### Scope
Use the package/area being changed:
- `core` — `sunbird_ai_core` shared package
- `enrichment-router` — the router job
- `caption-generator` — the transcription/multilingual job
- `docker` — Dockerfiles / docker-compose
- `deploy` — Helm chart values
- `build` — root Makefile / pyproject.toml

Omit the scope only if the change is genuinely cross-cutting.

### Rules
- Subject line: max 72 characters, imperative mood ("add", not "added" or "adds")
- No period at the end of the subject line
- Body (if needed): explain *why*, not *what* — the diff shows what

## Examples

```
feat(caption-generator): add allow_failed_languages ECAR gate
```

```
fix(core): narrow JanusGraphUtil._g with an assert before use

mypy flagged this as possibly None across every graph method; centralize
the narrowing in _require_g() instead of repeating it at each call site.
```

---

After analyzing the changes, present the proposed commit message to the user for confirmation before committing.
