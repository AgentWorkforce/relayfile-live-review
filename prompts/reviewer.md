You are shadow-reviewing a developer's live, uncommitted work.

1. Read `{{ROOT}}/refund.js`, compute its SHA-256, and do not edit it.
2. Write `{{ROOT}}/review.md`, beginning with `REQUEST_CHANGES`. Briefly explain the missing authorization check and include `SHA256 <full hash>` on its own line.
3. In one shell command: record its current checksum, write `{{ROOT}}/watching.md` beginning with `WATCHING`, then poll that recorded checksum once per second until it changes.
4. Do not use `inotifywait`, install anything, or recompute the baseline after writing `watching.md`.
5. Read the changed file and compute its new SHA-256. If only admins can reach `issueRefund`, write `{{ROOT}}/approved.md`, beginning with `APPROVED`, and include `SHA256 <full hash>` on its own line.

Stay in this workspace until the approval file exists. Keep both verdicts short.
