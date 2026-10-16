#!/bin/sh

set -eu

if ! command -v msgfmt >/dev/null 2>&1; then
  echo 'check-po-format: msgfmt not found (install gettext)' >&2
  exit 2
fi

if [ "$#" -eq 0 ]; then
  cd "$(dirname "$0")/.."
fi

if [ "$#" -eq 0 ]; then
  find translations -name '*.po' | sort
else
  printf '%s\n' "$@"
fi | {
  checked=0
  failed=0
  while IFS= read -r file; do
    checked=$((checked + 1))
    if ! msgfmt --check-format -o /dev/null "$file"; then
      failed=$((failed + 1))
      if [ "${GITHUB_ACTIONS:-}" = true ]; then
        printf '::error file=%s::msgfmt --check-format failed\n' "$file"
      fi
    fi
  done

  if [ "$checked" -eq 0 ]; then
    echo 'check-po-format: no .po files found' >&2
    exit 2
  fi

  printf 'check-po-format: %s checked, %s failed\n' "$checked" "$failed"
  if [ "$failed" -gt 0 ]; then
    exit 1
  fi
}
