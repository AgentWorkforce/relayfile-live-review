# Review the live file. There is no PR yet.

A Claude reviewer in a fresh cloud sandbox rejects an unsafe, uncommitted
file on your laptop. You fix it. The same reviewer approves it live. Relayfile
carries the bytes both ways, and your laptop proves they match by SHA-256.

```text
LAPTOP                         RELAYFILE                   SANDBOX
?? refund.js  ───────────────> live workspace ──────────> REQUEST_CHANGES
fixed bytes   ───────────────> live workspace ──────────> APPROVED
```

## Try it

Requires Node.js 20+ and Claude credentials.

```bash
git clone https://github.com/AgentWorkforce/relayfile-live-review.git
cd relayfile-live-review
./demo setup     # one Agent Relay login, then connect Claude
./demo           # complete end-to-end proof
```

## Demo it live

Run backstage before presenting:

```bash
./demo prep
```

After `READY`, open two terminals:

```text
terminal 1: ./demo show     # short reveal
terminal 2: ./demo watch    # optional view inside the sandbox
```

One Enter press reveals the rejection, sends the local fix, and shows the
approval. Cleanup is automatic; use `./demo clean` if you stop after prep.

## The proof

- Different machine, fresh sandbox, scoped Relayfile mount.
- Exact uncommitted bytes verified in both directions.
- Same reviewer reacts to the changed file.
- Git HEAD never moves: no commit, push, clone, or PR.

Without Relayfile, this needs a Git round trip, shared storage, or a custom
upload + polling service. The files behind the demo are [the unsafe code](example/refund.template.js),
[the reviewer prompt](prompts/reviewer.md), [the launcher](demo), and
[the orchestration](lib/run.mjs).

Daytona is the default. Where E2B sandbox capability is enabled, select it with
`RELAYFILE_DEMO_SANDBOX_PROVIDER=e2b ./demo`. Read-only is a reviewer
instruction, not an enforced permission. Displayed timing is observed
end-to-end reaction time, not a universal latency guarantee.
