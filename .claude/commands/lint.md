---
description: Run ruff + mypy across core and both jobs, summarize findings
allowed-tools: Bash(make *), Bash(ruff *), Bash(mypy *)
---

Run static checks for **ai-pipeline**:

```
make lint
# ruff check core jobs
# mypy core/sunbird_ai_core jobs/enrichment_router/enrichment_router jobs/caption_generator/caption_generator
```

After it finishes, summarize ruff findings grouped by rule code and mypy findings grouped by file, with counts. For any `X | None`-related mypy error, point at the `assert ... is not None` narrowing pattern described in `.claude/rules/base-class-pattern.md` as the expected fix — don't suggest `# type: ignore` as a first resort.

## Examples

```
/lint
```
