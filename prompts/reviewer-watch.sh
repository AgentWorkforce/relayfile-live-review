#!/usr/bin/env bash
set -euo pipefail

review_root="${1:?usage: reviewer-watch.sh <review-root>}"
cd "$review_root"

original_hash="$(sha256sum refund.js | awk '{print $1}')"
printf '%s\n' \
  'REQUEST_CHANGES' \
  'Anyone can issue a refund. Add an admin check.' \
  "SHA256 $original_hash" > review.md
printf '%s\n' 'WATCHING' > watching.md

while true; do
  current_hash="$(sha256sum refund.js | awk '{print $1}')"
  if [[ "$current_hash" != "$original_hash" ]]; then
    break
  fi
  sleep 1
done

if ! grep -Fq 'request.user?.role !== "admin"' refund.js; then
  printf '%s\n' 'The changed file does not contain the expected admin guard.' >&2
  exit 1
fi

printf '%s\n' \
  'APPROVED' \
  'Only admins can issue refunds.' \
  "SHA256 $current_hash" > approved.md
