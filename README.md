# A cloud agent reviews the file on your laptop—before you commit it

> Review the live file. There is no PR yet.

The demo creates an untracked `example/refund.js` locally. A Claude reviewer in
a fresh Daytona sandbox sees it, requests an authorization check, then approves your fix.
Relayfile carries the code and review across machines. No commit, push, clone,
or shared host path is used.

```text
YOUR LAPTOP                 RELAYFILE                 DAYTONA SANDBOX
refund.js  ───────────────> shared workspace ──────> Claude reviewer
review.md  <─────────────── shared workspace <────── REQUEST_CHANGES + SHA
fixed file ───────────────> shared workspace ──────> APPROVED
```

## Run it

You need Node.js 20+ and a Claude subscription or API credentials.

```bash
git clone https://github.com/AgentWorkforce/relayfile-live-review.git
cd relayfile-live-review
./demo setup     # one Agent Relay login, then connect Claude
./demo           # guided terminal demo
```

The demo prints a second command you can paste into another terminal to watch
the cloud reviewer work. `Ctrl-C` detaches that viewer without stopping it.
For a non-interactive proof run, use `./demo run`.

## What it proves

- The reviewer runs on a different machine in a newly provisioned Daytona sandbox.
- Its mount is scoped to this demo's Relayfile path; it receives no host path.
- Code and review artifacts travel in both directions before any git commit.
- The laptop verifies the SHA-256 of the exact bytes reviewed in Daytona.
- The same reviewer sees the second version and changes its verdict to `APPROVED`.
- Cleanup releases the agent and deletes the exact sandbox it created.

Without Relayfile, you would need a commit/push/checkout loop, shared storage, or
a custom upload, polling, and notification service. Relayfile makes the workspace
the collaboration surface, so reviewers, test agents, security agents, and humans
can shadow work while it is still being made.

This demo uses Daytona today, not E2B. “Read-only reviewer” is a behavioral
instruction: the agent can write its two review artifacts inside the scoped mount.
Timing shown for writes is acknowledgement latency, not a universal sync SLA.

## Read the whole demo

The story is intentionally split into four small files:

- [`example/refund.template.js`](example/refund.template.js) — the unsafe starter code
- [`prompts/reviewer.md`](prompts/reviewer.md) — the reviewer's assignment
- [`demo`](demo) — setup and command entry point
- [`lib/run.mjs`](lib/run.mjs) — Relayfile and sandbox orchestration
