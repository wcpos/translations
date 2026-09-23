#!/bin/bash
set -euo pipefail

DEFAULT_TRANSLATOR=codex # Local subscription CLI used for translation and review.
CODEX_MODEL=gpt-6-luna # Codex translate pass, mechanical tier.
CLAUDE_MODEL=sonnet # Default model for Claude.
CODEX_REVIEW_MODEL=gpt-6-sol # Default model for Codex review pass.
CLAUDE_REVIEW_MODEL=sonnet # Default model for Claude review pass.
DEFAULT_EFFORT=medium # Codex reasoning effort.
MAX_PER_CALL=250 # Maximum summed packet items per call, except oversized packets.
CALL_TIMEOUT=1800 # Seconds allowed for each translation or review call.
RETRY_AFTER=86400 # Seconds before retrying work that an earlier run left untranslated.

chunks() {
  node -e 'const fs=require("fs"),path=require("path"),[dir,max]=process.argv.slice(1); let chunk=[],sum=0;
    for(const file of fs.readdirSync(dir).filter(f=>f.endsWith(".json")).sort()){
      const p=JSON.parse(fs.readFileSync(path.join(dir,file))),n=p.counts.js+p.counts.php;
      if(chunk.length && sum+n>Number(max)){console.log(chunk.join(" "));chunk=[];sum=0;}
      chunk.push(file.slice(0,-5));sum+=n;
    } if(chunk.length)console.log(chunk.join(" "));' "$1" "$2"
}
if [ "${TRANSLATE_CHUNK_SELFTEST:-}" = 1 ]; then
  chunks "$1" "$MAX_PER_CALL"
  exit 0
fi

log() { printf '[translate-local] %s\n' "$*"; }
TRANSLATOR=${TRANSLATE_TRANSLATOR:-$DEFAULT_TRANSLATOR}
MODEL=${TRANSLATE_MODEL:-}
REVIEW_MODEL=${TRANSLATE_REVIEW_MODEL:-}
EFFORT=${TRANSLATE_EFFORT:-$DEFAULT_EFFORT}
BASE=main
DRY_RUN=0
RETRY=0
REVIEW=1
WORKLIST_ARGS=(--out .translate/work)
ORIGINAL_ARGS=("$@")
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --retry) RETRY=1; shift ;;
    --no-review) REVIEW=0; shift ;;
    --base) BASE=$2; shift 2 ;;
    --locale) WORKLIST_ARGS+=(--locale "$2"); shift 2 ;;
    --translator) TRANSLATOR=$2; shift 2 ;;
    --model) MODEL=$2; shift 2 ;;
    --review-model) REVIEW_MODEL=$2; shift 2 ;;
    --effort) EFFORT=$2; shift 2 ;;
    --max-per-call) MAX_PER_CALL=$2; shift 2 ;;
    *) log "unknown argument: $1"; exit 1 ;;
  esac
done
case "$TRANSLATOR" in
  codex) MODEL=${MODEL:-$CODEX_MODEL}; REVIEW_MODEL=${REVIEW_MODEL:-$CODEX_REVIEW_MODEL} ;;
  claude) MODEL=${MODEL:-$CLAUDE_MODEL}; REVIEW_MODEL=${REVIEW_MODEL:-$CLAUDE_REVIEW_MODEL} ;;
  *) log "unknown translator: $TRANSLATOR"; exit 1 ;;
esac
case "$MAX_PER_CALL" in
  ''|*[!0-9]*) log "max-per-call must be a positive integer"; exit 1 ;;
esac
if [ "$MAX_PER_CALL" -eq 0 ]; then log "max-per-call must be positive"; exit 1; fi
PATH=/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH
export PATH
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=${TRANSLATE_REPO_ROOT:-}
if [ -z "$REPO_ROOT" ]; then
  REPO_ROOT=$(dirname "$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir)")
fi
git -C "$REPO_ROOT" fetch --quiet --prune origin
if [ -z "${TRANSLATE_LOCAL_REEXEC+x}" ]; then
  UPDATE=$(mktemp)
  if git -C "$REPO_ROOT" show "origin/$BASE:scripts/translate-local.sh" >"$UPDATE" 2>/dev/null &&
      ! cmp -s "$0" "$UPDATE"; then
    TRANSLATE_LOCAL_REEXEC=1 TRANSLATE_REPO_ROOT="$REPO_ROOT" exec /bin/bash "$UPDATE" ${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}
  fi
  rm -f "$UPDATE"
fi
mkdir -p "$REPO_ROOT/.claude"
LOCK="$REPO_ROOT/.claude/auto-translate.lock"
STATE="$REPO_ROOT/.claude/auto-translate.state"
exec 9>"$LOCK"
if ! /usr/bin/lockf -s -t 0 9; then log "already running"; exit 0; fi

WT="$REPO_ROOT/.claude/worktrees/auto-translate"
if ! git -C "$REPO_ROOT" worktree list --porcelain | grep -Fxq "worktree $WT"; then
  git -C "$REPO_ROOT" worktree add --detach "$WT" "origin/$BASE"
fi
cd "$WT"
git reset --hard --quiet
git clean -fdq
rm -rf .translate
PR=$(gh pr list -R wcpos/translations --state open --base "$BASE" --label auto-translate --json number,headRefName,url --jq '.[0] // empty')
if [ -n "$PR" ]; then
  BRANCH=$(printf '%s' "$PR" | jq -r .headRefName)
  PR_NUMBER=$(printf '%s' "$PR" | jq -r .number)
  PR_URL=$(printf '%s' "$PR" | jq -r .url)
  git checkout -q -B "$BRANCH" "origin/$BRANCH"
  if ! git merge -q --no-edit "origin/$BASE"; then
    git merge --abort
    log "merge failed for PR $PR_NUMBER ($PR_URL)"
    exit 1
  fi
else
  BRANCH="auto-translate/$(date -u +%Y%m%d-%H%M%S)"
  git checkout -q -B "$BRANCH" "origin/$BASE"
fi
pnpm install --frozen-lockfile --prefer-offline --silent
SUMMARY=$(node scripts/translation-worklist.js "${WORKLIST_ARGS[@]}")
TOTAL=$(printf '%s' "$SUMMARY" | jq -r .total)
if [ "$TOTAL" -eq 0 ]; then log "nothing to translate"; exit 0; fi
WORK_HASH=$(cat .translate/work/*.json | shasum -a 256 | cut -d' ' -f1)
if [ "$DRY_RUN" -eq 1 ]; then printf '%s\n' "$SUMMARY"; exit 0; fi
if [ "$RETRY" -eq 0 ] && [ -f "$STATE" ]; then
  read -r RECORDED < "$STATE"
  if [ "$(( $(date +%s) - RECORDED ))" -lt "$RETRY_AFTER" ] && tail -n +2 "$STATE" | grep -Fxq "$WORK_HASH"; then
    log "same work as an unsuccessful run at $(date -u -r "$RECORDED" +%Y-%m-%dT%H:%M:%SZ); skipping the model until $(date -u -r "$((RECORDED + RETRY_AFTER))" +%Y-%m-%dT%H:%M:%SZ) (pass --retry to override)"
    exit 0
  fi
fi

run_with_timeout() {
  local pid watchdog status=0
  set -m
  "$@" &
  pid=$!
  ( sleep "$CALL_TIMEOUT"; kill -KILL -- "-$pid" 2>/dev/null || true ) &
  watchdog=$!
  set +m
  wait "$pid" || status=$?
  kill -KILL -- "-$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  return "$status"
}
if [ "$TRANSLATOR" = codex ]; then
  COMMAND=(codex exec -m "$MODEL" -c "model_reasoning_effort=\"$EFFORT\"" -c 'approval_policy="never"' -s workspace-write -C "$WT" -)
  REVIEW_COMMAND=(codex exec -m "$REVIEW_MODEL" -c "model_reasoning_effort=\"$EFFORT\"" -c 'approval_policy="never"' -s workspace-write -C "$WT" -)
else
  COMMAND=(claude -p --model "$MODEL" --permission-mode acceptEdits --allowedTools "Read,Write,Glob,Grep")
  REVIEW_COMMAND=(claude -p --model "$REVIEW_MODEL" --permission-mode acceptEdits --allowedTools "Read,Write,Glob,Grep")
fi
mkdir -p .translate/results .translate/logs
chunks .translate/work "$MAX_PER_CALL" > .translate/chunks
CHUNK=0
REVIEW_USED=skipped
while IFS= read -r LOCALES; do
  CHUNK=$((CHUNK + 1))
  cat scripts/translate-prompt.md > .translate/prompt
  for LOCALE in $LOCALES; do
    printf '\n- .translate/work/%s.json -> .translate/results/%s.json\n' "$LOCALE" "$LOCALE" >> .translate/prompt
  done
  if ! run_with_timeout "${COMMAND[@]}" < .translate/prompt > ".translate/logs/chunk-$CHUNK.log" 2>&1; then
    log "chunk $CHUNK failed or timed out; continuing"
  fi
  HAS_RESULTS=0
  for LOCALE in $LOCALES; do
    if [ -f ".translate/results/$LOCALE.json" ]; then HAS_RESULTS=1; fi
  done
  if [ "$REVIEW" -eq 1 ] && [ "$HAS_RESULTS" -eq 1 ]; then
    REVIEW_USED=$REVIEW_MODEL
    cat scripts/review-prompt.md > .translate/prompt
    for LOCALE in $LOCALES; do
      printf '\n- .translate/work/%s.json -> .translate/results/%s.json\n' "$LOCALE" "$LOCALE" >> .translate/prompt
    done
    if ! run_with_timeout "${REVIEW_COMMAND[@]}" < .translate/prompt > ".translate/logs/review-$CHUNK.log" 2>&1; then
      log "review $CHUNK failed or timed out; continuing"
    fi
  fi
done < .translate/chunks
APPLY_SUMMARY=$(node scripts/apply-translations.js --work .translate/work --results .translate/results --report .translate/report.json --report-md .translate/report.md)
log "$APPLY_SUMMARY"
REMAINING_SUMMARY=$(node scripts/translation-worklist.js "${WORKLIST_ARGS[@]}" --out .translate/remaining)
if [ "$(printf '%s' "$REMAINING_SUMMARY" | jq -r .total)" -gt 0 ]; then
  REMAINING_HASH=$(cat .translate/remaining/*.json | shasum -a 256 | cut -d' ' -f1)
  printf '%s\n' "$(date +%s)" "$WORK_HASH" "$REMAINING_HASH" > "$STATE"
else
  rm -f "$STATE"
fi
if [ -z "$(git status --porcelain -- translations)" ]; then log "no translations accepted"; exit 1; fi
if ! node scripts/validate-translations.js; then
  log "validation failed; worktree left at $WT"
  exit 1
fi
APPLIED=$(jq -r .applied .translate/report.json)
LOCALES=$(jq -r '[.files_written[] | split("/")[2]] | unique | join(", ")' .translate/report.json)
N_LOCALES=$(jq '[.files_written[] | split("/")[2]] | unique | length' .translate/report.json)
{
  printf 'Applied %s strings for %s locales (%s); translator: %s (%s); review: %s.\n\n' "$APPLIED" "$N_LOCALES" "$LOCALES" "$TRANSLATOR" "$MODEL" "$REVIEW_USED"
  cat .translate/report.md
  printf '\n'
  node scripts/check-translation-quality.js --changed-since "origin/$BASE" --markdown
  printf '\n~~~\n'
  node scripts/check-completeness.js --warn-only | grep -E '^(Errors:|Warnings:)'
  printf '~~~\n\nGenerated by scripts/translate-local.sh on %s at %s.\n' "$(hostname)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > .translate/pr-body.md
git add translations
git commit -m "chore(i18n): translate $APPLIED strings for $N_LOCALES locales"
if [ "$BRANCH" = main ] || [ "$BRANCH" = "$BASE" ]; then log "refusing to push to $BRANCH"; exit 1; fi
git push --quiet -u origin "$BRANCH"
if [ -n "$PR" ]; then
  gh pr comment "$PR_NUMBER" --body-file .translate/pr-body.md > /dev/null
else
  gh label create auto-translate --color 1d76db --description "Automated local translation run" 2>/dev/null || true
  PR_URL=$(gh pr create -R wcpos/translations --base "$BASE" --head "$BRANCH" --label auto-translate --title "chore(i18n): automated translations $(date -u +%Y-%m-%d)" --body-file .translate/pr-body.md)
fi
log "$PR_URL"
exit 0
