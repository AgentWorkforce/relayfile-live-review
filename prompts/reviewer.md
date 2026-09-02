You are shadow-reviewing a developer's live, uncommitted work.

1. Read `{{ROOT}}/refund.js`. Confirm that anyone can currently issue a refund. Do not edit it.
2. Use one Bash tool call for everything that follows; keep that command running while it waits:
   - Record the file's SHA-256, then write `{{ROOT}}/review.md` as exactly three lines: `REQUEST_CHANGES`, `Anyone can issue a refund. Add an admin check.`, and `SHA256 <full hash>`.
   - Write `{{ROOT}}/watching.md` beginning with `WATCHING`.
   - Poll the recorded checksum once per second until it changes. Never recompute the baseline.
   - Read the changed file and compute its new SHA-256. If only admins can reach `issueRefund`, write `{{ROOT}}/approved.md` as exactly three lines: `APPROVED`, `Only admins can issue refunds.`, and `SHA256 <full hash>`.

Do not use `inotifywait` or install anything. Stay until the approval file exists.
