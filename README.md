# Edit here. Watch it appear in Daytona.

Relayfile keeps one ordinary file live across two machines. The demo opens a
split terminal, SSHes into a fresh Daytona sandbox, and tails the mounted file.
Then it edits the laptop copy:

```text
LAPTOP                              DAYTONA SANDBOX
$ cat shared/launch.txt             $ daytona ssh relayfile-live-…
launch: waiting                     $ tail -F …/launch.txt
                                    launch: waiting
$ printf 'launch: now\n' > …
                                    launch: now
```

That last line is the proof: the Daytona filesystem changed while `tail -F`
was already running. There is no Git commit, push, clone, or PR.

## Run it

Requires Node.js 20+, `tmux`, the Daytona CLI, and Claude credentials. Sign in
to the Daytona CLI once so the demo can show the real SSH session.

```bash
git clone https://github.com/AgentWorkforce/relayfile-live-review.git
cd relayfile-live-review
daytona login
./demo setup
./demo
```

`./demo setup` uses the Agent Relay Cloud login and connects Claude. It does
not require a second Relayfile login.

## Present it without waiting

Provision the sandbox backstage:

```bash
./demo prep
```

After `READY`, run the visible proof:

```bash
./demo tail
```

The right pane runs a real `daytona ssh` followed by a real `tail -F`. The left
pane pre-types the local `printf` command; press Enter once to execute it.
Cleanup is automatic when running `./demo`; after a standalone prep/tail run,
use `./demo clean`.

The older agent-review proof remains available as `./demo split`. Daytona is
the default sandbox provider; the direct SSH-tail proof is Daytona-specific.
