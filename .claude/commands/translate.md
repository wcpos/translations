---
description: Fill missing WCPOS app/plugin translations and open or update the auto-translate PR
argument-hint: "[--dry-run] [--locale L]... [--translator codex|claude] [--model M]"
---

Run the local translation pipeline, which replaced the OpenClaw/Aide webhook in September 2026.

```bash
scripts/translate-local.sh $ARGUMENTS
```

The script decides deterministically whether there is anything to do, so do not
translate strings yourself in this session. It works in its own worktree
(`.claude/worktrees/auto-translate`) and never touches this checkout.

1. Run the command from the repository root. With no work it exits 0 after
   "nothing to translate", and there is nothing more to do.
2. Otherwise it delegates translation to the chosen model CLI (default: Codex
   `gpt-6-luna` with a `gpt-6-sol` review pass; `--translator claude` uses Claude Sonnet), applies the results
   through `scripts/apply-translations.js`, validates, then pushes and opens a PR
   labelled `auto-translate` (or comments on the open one).
3. Report back with the PR URL, the applied/rejected/warning counts from the script's
   output, and any rejected strings. Rejected strings stay untranslated and are
   retried on the next run.
4. On a non-zero exit, show the last 30 lines of output and the chunk logs in
   `.claude/worktrees/auto-translate/.translate/logs/`. Do not rerun more than once.

Use `--dry-run` to see the per-locale work summary without calling a model. If the output says `same work as an unsuccessful run`, the strings failed validation less than 24 hours ago; pass `--retry` to try again now.
