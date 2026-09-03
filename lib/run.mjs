import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examplePath = path.join(root, "example", "refund.js");
const templatePath = path.join(root, "example", "refund.template.js");
const promptPath = path.join(root, "prompts", "reviewer.md");
const watcherPath = path.join(root, "prompts", "reviewer-watch.sh");
const stateDir = path.join(root, ".demo-state");
const statePath = path.join(stateDir, "state.json");
const sharedDir = path.join(root, "shared");
const launchPath = path.join(sharedDir, "launch.txt");
const action = process.argv[2] || "run";
const sandboxProvider = process.env.RELAYFILE_DEMO_SANDBOX_PROVIDER || "daytona";
const interactive = process.stdin.isTTY && process.stdout.isTTY;
let runtime = null;
let prepared = false;
let cleanupPromise = null;

const colors = process.stdout.isTTY ? {
  bold: "\u001b[1m", cyan: "\u001b[36m", green: "\u001b[32m",
  yellow: "\u001b[33m", dim: "\u001b[2m", reset: "\u001b[0m",
} : { bold: "", cyan: "", green: "", yellow: "", dim: "", reset: "" };

const unsafeCode = `${(await fs.readFile(templatePath, "utf8")).trimEnd()}

// uncommitted
`;

const fixedCode = `export async function refund(request) {
  if (request.user?.role !== "admin") throw new Error("Forbidden");
  return issueRefund(request.orderId, request.amount);
}

// uncommitted
`;

const launchBefore = "launch: waiting\n";
const launchAfter = "launch: now\n";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value) {
  return value.slice(0, 12);
}

function reviewHash(value) {
  const match = value.match(/SHA256 ([a-f0-9]{64})/i);
  if (!match) throw new Error("Reviewer did not include a full SHA-256.");
  return match[1].toLowerCase();
}

function reviewSummary(value) {
  return value.trim().split("\n").filter((line) => !line.startsWith("SHA256 ")).slice(0, 2).join("\n");
}

async function command(program, args, options = {}) {
  return exec(program, args, { maxBuffer: 10 * 1024 * 1024, ...options });
}

async function commandWithRetry(program, args, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await command(program, args, options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(attempt * 750);
    }
  }
  throw lastError;
}

function parseJsonOutput(raw) {
  const start = raw.indexOf("{");
  if (start < 0) throw new Error(`Expected JSON output, received: ${raw}`);
  return JSON.parse(raw.slice(start));
}

async function gitHead() {
  try {
    return (await command("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  } catch {
    return "no-commit";
  }
}

async function pause(message) {
  if (!interactive) return;
  process.stdout.write(`${colors.dim}\nPress Enter ${message}…${colors.reset}`);
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once("data", resolve));
  process.stdin.pause();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPane(tmux, target, text, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { stdout } = await tmux(["capture-pane", "-p", "-S", "-", "-t", target]);
    if (stdout.includes(text)) return stdout;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(text)} in the ${target} pane.`);
}

async function sendLine(tmux, target, line) {
  await tmux(["send-keys", "-l", "-t", target, line]);
  await tmux(["send-keys", "-t", target, "Enter"]);
}

async function preflight() {
  await command("agent-relay", ["cloud", "whoami"]);
  await command("relayfile", ["workspace", "current"]);
  if (!process.env.RELAYFILE_SDK_ENTRY || !process.env.AGENT_RELAY_CLOUD_ENTRY) {
    throw new Error("Demo package paths were not initialized.");
  }
}

async function relayfileClient(expectedWorkspaceId) {
  const authPath = path.join(os.homedir(), ".agentworkforce", "relay", "cloud-auth.json");
  const auth = JSON.parse(await fs.readFile(authPath, "utf8"));
  let workspaceId = expectedWorkspaceId;
  if (!workspaceId) {
    const { stdout } = await commandWithRetry("agent-relay", ["workspace", "active", "--json"]);
    workspaceId = parseJsonOutput(stdout).relayfileWorkspaceId;
  }
  const { RelayfileSetup } = await import(pathToFileURL(process.env.RELAYFILE_SDK_ENTRY).href);
  const setup = RelayfileSetup.fromCloudTokens(auth, { cloudApiUrl: auth.apiUrl });
  const workspace = await setup.joinWorkspace(workspaceId, {
    agentName: "relayfile-live-review-demo",
    scopes: ["fs:read", "fs:write"],
  });
  const invite = workspace.agentInvite();
  return {
    client: workspace.client(),
    workspaceId: workspace.workspaceId,
    relayfileUrl: invite.relayfileUrl,
    relayfileToken: invite.relayfileToken,
  };
}

async function relayfileClientFromState(state) {
  if (!state.relayfileUrl || !state.relayfileToken) {
    throw new Error("Prepared Relayfile credentials are missing. Run ./demo clean, then ./demo prep.");
  }
  const { RelayFileClient } = await import(pathToFileURL(process.env.RELAYFILE_SDK_ENTRY).href);
  return new RelayFileClient({ baseUrl: state.relayfileUrl, token: state.relayfileToken });
}

async function publish(client, workspaceId, files) {
  const result = await client.bulkWrite({ workspaceId, files });
  if (result.errorCount) {
    throw new Error(result.errors.map((item) => item.message).join("; "));
  }
}

async function waitFor(client, workspaceId, remotePath, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const file = await client.readFile(workspaceId, remotePath);
      if (file.content.trim()) return file.content;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${remotePath}`);
}

async function spawnReviewer(state) {
  if (!new Set(["daytona", "e2b"]).has(sandboxProvider)) {
    throw new Error("RELAYFILE_DEMO_SANDBOX_PROVIDER must be daytona or e2b.");
  }
  const args = [
    "fleet", "spawn", "claude", "--sandbox",
    "--sandbox-provider", sandboxProvider,
    "--sandbox-name", `relayfile-${state.runId}`,
    "--sandbox-relayfile-path", `${state.remoteRoot}/**`,
    "--name", state.reviewer,
    "--task", `Read .${state.remoteRoot}/reviewer.md and follow it now.`,
  ];
  const { stdout } = await command("agent-relay", args, { timeout: 10 * 60_000 });
  const sandbox = parseJsonOutput(stdout).sandbox;
  return {
    cloudWorkspaceId: sandbox.cloudWorkspaceId,
    sandboxId: sandbox.sandboxId,
    nodeName: sandbox.nodeName,
    provider: sandbox.provider || sandboxProvider,
  };
}

async function saveState(state) {
  await fs.mkdir(stateDir, { recursive: true });
  const next = `${statePath}.next`;
  await fs.writeFile(next, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(next, statePath);
}

async function loadState(required = true) {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error) {
    if (!required && error.code === "ENOENT") return null;
    if (error.code === "ENOENT") throw new Error("Nothing is prepped. Run ./demo prep first.");
    throw error;
  }
}

async function cleanup(state = runtime) {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    let remoteClean = true;
    if (state?.sandbox) {
      await command("agent-relay", [
        "fleet", "release", state.reviewer, "--delete-agent", "--reason", "Relayfile demo cleanup",
      ]).catch(() => {});
      try {
        const cloud = await import(pathToFileURL(process.env.AGENT_RELAY_CLOUD_ENTRY).href);
        await cloud.deleteCloudFleetSandbox({
          cloudWorkspaceId: state.sandbox.cloudWorkspaceId,
          sandboxId: state.sandbox.sandboxId,
        });
      } catch (error) {
        remoteClean = false;
        console.error(`Sandbox cleanup warning: ${error.message}`);
      }
    }
    await fs.rm(examplePath, { force: true });
    await fs.rm(sharedDir, { recursive: true, force: true });
    if (remoteClean) {
      await fs.rm(stateDir, { recursive: true, force: true });
    } else {
      console.error("Cleanup state was retained; retry with ./demo clean.");
    }
  })();
  return cleanupPromise;
}

async function prepare() {
  await preflight();
  if (await loadState(false)) {
    throw new Error("A prepared demo already exists. Run ./demo show or ./demo clean.");
  }
  try {
    await fs.access(examplePath);
    throw new Error("example/refund.js already exists; move it aside before running the demo.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  console.log(`${colors.bold}PREP${colors.reset}  Starting a fresh ${sandboxProvider.toUpperCase()} sandbox…`);
  const { client, workspaceId, relayfileUrl, relayfileToken } = await relayfileClient();
  const runId = `live-${Date.now().toString(36).slice(-5)}-${Math.floor(Math.random() * 1_000)}`;
  runtime = {
    version: 3,
    runId,
    remoteRoot: `/live-review/${runId}`,
    reviewer: `reviewer-${runId}`,
    workspaceId,
    relayfileUrl,
    relayfileToken,
    startedCommit: await gitHead(),
    firstHash: sha256(unsafeCode),
  };

  await fs.mkdir(sharedDir, { recursive: true });
  await fs.writeFile(examplePath, unsafeCode);
  await fs.writeFile(launchPath, launchBefore);
  const prompt = (await fs.readFile(promptPath, "utf8")).replaceAll("{{ROOT}}", `.${runtime.remoteRoot}`);
  const watcher = await fs.readFile(watcherPath, "utf8");
  await publish(client, workspaceId, [
    { path: `${runtime.remoteRoot}/refund.js`, content: unsafeCode },
    { path: `${runtime.remoteRoot}/reviewer.md`, content: prompt },
    { path: `${runtime.remoteRoot}/reviewer-watch.sh`, content: watcher },
    { path: `${runtime.remoteRoot}/launch.txt`, content: launchBefore },
  ]);

  runtime.sandbox = await spawnReviewer(runtime);
  await saveState(runtime);
  runtime.review = await waitFor(client, workspaceId, `${runtime.remoteRoot}/review.md`);
  if (!runtime.review.startsWith("REQUEST_CHANGES")) throw new Error("Expected REQUEST_CHANGES verdict.");
  if (reviewHash(runtime.review) !== runtime.firstHash) throw new Error("Review SHA-256 did not match the laptop bytes.");
  const watching = await waitFor(client, workspaceId, `${runtime.remoteRoot}/watching.md`);
  if (!watching.startsWith("WATCHING")) throw new Error("Expected WATCHING handshake.");

  await saveState(runtime);
  prepared = true;
  console.log(`${colors.green}READY${colors.reset} The Daytona sandbox has the Relayfile workspace mounted.`);
  console.log(`\nFor the live reveal: ${colors.bold}./demo tail${colors.reset}`);
  return runtime;
}

async function show(state) {
  state ??= await loadState();
  runtime = state;
  const currentCode = await fs.readFile(examplePath, "utf8");
  if (sha256(currentCode) !== state.firstHash) {
    throw new Error("The prepped local file changed. Run ./demo clean and prep again.");
  }
  const client = await relayfileClientFromState(state);
  const workspaceId = state.workspaceId;
  if (interactive && !process.env.RELAYFILE_DEMO_NO_CLEAR) process.stdout.write("\u001b[2J\u001b[H");

  console.log(`${colors.bold}LIVE REVIEW · ONE FILE, TWO MACHINES${colors.reset}\n`);
  const status = (await command("git", ["status", "--short", "--", "example/refund.js"], { cwd: root })).stdout.trim();
  const unsafeReturn = currentCode.split("\n").find((line) => line.includes("return issueRefund"))?.trim();
  console.log(`${colors.cyan}LAPTOP${colors.reset}`);
  console.log(`${colors.dim}$ git status --short -- example/refund.js${colors.reset}`);
  console.log(`${colors.yellow}${status}${colors.reset}  ${colors.dim}(not committed)${colors.reset}`);
  console.log(`  ${unsafeReturn}`);

  const providerLabel = (state.sandbox.provider || "daytona").toUpperCase();
  const reviewLines = reviewSummary(state.review).split("\n");
  console.log(`\n${colors.cyan}RELAYFILE${colors.reset}  exact bytes ─────────▶  ${providerLabel} SANDBOX`);
  console.log(`${colors.dim}same SHA-256 on both machines: ${shortHash(state.firstHash)} ✓${colors.reset}`);
  console.log(`\n${colors.cyan}CLOUD REVIEWER${colors.reset}  ${colors.dim}${state.reviewer}${colors.reset}`);
  console.log(`${colors.yellow}${reviewLines[0]}${colors.reset}  ${reviewLines[1]}`);

  await pause("to fix it on the laptop");
  await fs.writeFile(examplePath, fixedCode);
  const fixedGuard = fixedCode.split("\n").find((line) => line.includes("request.user?.role"))?.trim();
  console.log(`\n${colors.cyan}LAPTOP EDIT${colors.reset}`);
  console.log(`${colors.green}+ ${fixedGuard}${colors.reset}`);
  const secondHash = sha256(fixedCode);
  const started = performance.now();
  console.log(`\n${colors.cyan}RELAYFILE${colors.reset}  same file ─────────▶  SAME CLOUD REVIEWER`);
  process.stdout.write(`${colors.dim}waiting for the verdict…${colors.reset}`);
  await publish(client, workspaceId, [
    { path: `${state.remoteRoot}/refund.js`, content: fixedCode },
  ]);

  const approval = await waitFor(client, workspaceId, `${state.remoteRoot}/approved.md`);
  const reactedMs = Math.round(performance.now() - started);
  process.stdout.write("\r\u001b[2K");
  if (!approval.startsWith("APPROVED")) throw new Error("Expected APPROVED verdict.");
  if (reviewHash(approval) !== secondHash) throw new Error("Approval SHA-256 did not match the laptop bytes.");

  const approvalLines = reviewSummary(approval).split("\n");
  console.log(`${colors.cyan}CLOUD REVIEWER → LAPTOP${colors.reset}`);
  console.log(`${colors.green}${approvalLines[0]}${colors.reset}  ${approvalLines[1]}`);
  console.log(`${colors.dim}same SHA-256 on both machines: ${shortHash(secondHash)} ✓${colors.reset}`);
  console.log(`${colors.dim}reviewer reacted in ${(reactedMs / 1000).toFixed(1)}s${colors.reset}`);

  const finishedCommit = await gitHead();
  if (finishedCommit !== state.startedCommit) throw new Error("Git HEAD changed during the demo.");
  const finalStatus = (await command("git", ["status", "--short", "--", "example/refund.js"], { cwd: root })).stdout.trim();
  console.log(`\n${colors.cyan}STILL ON THE LAPTOP${colors.reset}`);
  console.log(`${colors.dim}$ git status --short -- example/refund.js${colors.reset}`);
  console.log(`${colors.yellow}${finalStatus}${colors.reset}`);
  console.log(`${colors.bold}NO COMMIT · NO PUSH · NO PR${colors.reset}`);
}

async function watch() {
  const state = await loadState();
  console.log(`Watching ${state.reviewer} in ${state.sandbox.nodeName}. Ctrl-C only detaches.`);
  await new Promise((resolve, reject) => {
    const child = spawn("agent-relay", [
      "node", "agent", "attach", state.reviewer,
      "--node", state.sandbox.nodeName, "--mode", "view",
    ], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

async function events() {
  const state = await loadState();
  runtime = state;

  const provider = (state.sandbox.provider || sandboxProvider).toUpperCase();
  const client = await relayfileClientFromState(state);
  const workspaceId = state.workspaceId;
  const remoteCode = await client.readFile(workspaceId, `${state.remoteRoot}/refund.js`);
  const remoteHash = sha256(remoteCode.content);
  if (remoteHash !== state.firstHash) throw new Error("The relayed Daytona bytes do not match the laptop.");

  if (interactive && !process.env.RELAYFILE_DEMO_NO_CLEAR) process.stdout.write("\u001b[2J\u001b[H");
  console.log(`${colors.bold}${provider} REVIEWER${colors.reset}`);
  console.log(`${colors.dim}PREP  agent-relay fleet spawn claude --sandbox --sandbox-provider ${provider.toLowerCase()}${colors.reset}`);
  console.log(`${colors.green}CONNECTED${colors.reset}  ${state.sandbox.nodeName}`);
  console.log(`${colors.dim}sandbox ${state.sandbox.sandboxId}${colors.reset}`);
  console.log(`\n${colors.bold}RELAYFILE FILESYSTEM${colors.reset}`);
  console.log(`${colors.dim}$ SDK connectWebSocket("${state.remoteRoot}/**")${colors.reset}`);
  const connection = client.connectWebSocket(workspaceId, {
    from: "now",
    paths: [`${state.remoteRoot}/**`],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Relayfile event stream did not open.")), 15_000);
    const offOpen = connection.on("open", () => {
      clearTimeout(timeout);
      offOpen();
      offError();
      resolve();
    });
    const offError = connection.on("error", (error) => {
      clearTimeout(timeout);
      offOpen();
      offError();
      reject(error instanceof Error ? error : new Error("Relayfile event stream failed."));
    });
  });
  console.log(`${colors.green}SUBSCRIBED${colors.reset}  WebSocket live`);
  console.log(`${colors.dim}Daytona read refund.js · ${shortHash(remoteHash)} ✓${colors.reset}\n`);

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for the approval event.")), 10 * 60_000);
      const offEvent = connection.on("event", (event) => {
        if (event.path === `${state.remoteRoot}/refund.js`) {
          console.log(`${colors.cyan}LAPTOP → RELAYFILE${colors.reset}  ${event.type}  refund.js`);
        }
        if (event.path === `${state.remoteRoot}/approved.md`) {
          console.log(`${colors.green}DAYTONA → RELAYFILE${colors.reset}  ${event.type}  approved.md`);
          console.log(`${colors.green}THE REMOTE AGENT REACTED TO THE LOCAL EDIT${colors.reset}`);
          clearTimeout(timeout);
          offEvent();
          offError();
          offClose();
          resolve();
        }
      });
      const offError = connection.on("error", (error) => {
        clearTimeout(timeout);
        offEvent();
        offError();
        offClose();
        reject(error instanceof Error ? error : new Error("Relayfile event stream failed."));
      });
      const offClose = connection.on("close", () => {
        clearTimeout(timeout);
        offEvent();
        offError();
        offClose();
        reject(new Error("Relayfile event stream closed before approval."));
      });
    });
  } finally {
    connection.close(1000, "demo complete");
  }
}

async function tailInDaytona() {
  const state = await loadState();
  runtime = state;
  if (!interactive) throw new Error("Daytona tail mode requires an interactive terminal.");
  if ((state.sandbox.provider || sandboxProvider) !== "daytona") {
    throw new Error("Daytona tail mode requires RELAYFILE_DEMO_SANDBOX_PROVIDER=daytona.");
  }
  await command("tmux", ["-V"]);
  await command("daytona", ["--version"]);

  const client = await relayfileClientFromState(state);
  const remoteFile = `${state.remoteRoot}/launch.txt`;
  const remote = await client.readFile(state.workspaceId, remoteFile);
  const local = await fs.readFile(launchPath, "utf8");
  if (remote.content !== launchBefore || local !== launchBefore) {
    throw new Error("The launch file changed after prep. Run ./demo clean, then ./demo prep.");
  }

  const session = `relayfile-tail-${state.runId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const socket = `rf-tail-${state.runId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const tmux = (args, options) => command("tmux", ["-L", socket, ...args], options);
  const columns = Math.max(process.stdout.columns || 180, 140);
  const rows = Math.max(process.stdout.rows || 46, 36);
  const leftPane = `${session}:0.0`;
  const rightPane = `${session}:0.1`;
  const remoteAbsolute = `/home/daytona/workspace${remoteFile}`;

  await tmux(["new-session", "-d", "-s", session, "-x", String(columns), "-y", String(rows), "-c", root, "/bin/bash --noprofile --norc"]);
  try {
    await tmux(["set-option", "-t", session, "status", "off"]);
    await tmux(["set-option", "-t", session, "pane-border-status", "top"]);
    await tmux(["set-option", "-t", session, "pane-border-format", " #{pane_title} "]);
    await tmux(["set-option", "-t", session, "pane-border-style", "fg=colour8"]);
    await tmux(["set-option", "-t", session, "pane-active-border-style", "fg=colour14"]);
    await tmux(["select-pane", "-t", leftPane, "-T", "LAPTOP · EDIT shared/launch.txt"]);
    await tmux(["split-window", "-h", "-p", "50", "-t", `${session}:0`, "-c", root, "/bin/bash --noprofile --norc"]);
    await tmux(["select-pane", "-t", rightPane, "-T", "DAYTONA · RELAYFILE MOUNT"]);
    for (const pane of [leftPane, rightPane]) {
      await sendLine(tmux, pane, "export PS1='$ '");
      await sendLine(tmux, pane, "clear");
    }

    const attached = spawn("tmux", ["-L", socket, "attach-session", "-t", session], { stdio: "inherit" });
    const attachedExit = new Promise((resolve, reject) => {
      attached.once("error", reject);
      attached.once("exit", resolve);
    });

    await delay(700);
    await sendLine(tmux, rightPane, `daytona ssh ${state.sandbox.nodeName} 2>/dev/null`);
    await waitForPane(tmux, rightPane, "daytona@", 30_000);
    await sendLine(tmux, rightPane, `tail -n +1 -F ${remoteAbsolute}`);
    await waitForPane(tmux, rightPane, launchBefore.trim(), 30_000);

    await sendLine(tmux, leftPane, "cat shared/launch.txt");
    await tmux(["send-keys", "-l", "-t", leftPane, "printf 'launch: now\\n' > shared/launch.txt"]);
    await tmux(["select-pane", "-t", leftPane]);

    const editDeadline = Date.now() + 10 * 60_000;
    while (Date.now() < editDeadline) {
      if ((await fs.readFile(launchPath, "utf8")) === launchAfter) break;
      await delay(25);
    }
    if ((await fs.readFile(launchPath, "utf8")) !== launchAfter) {
      throw new Error("Timed out waiting for the laptop edit.");
    }

    await publish(client, state.workspaceId, [{ path: remoteFile, content: launchAfter }]);
    await waitForPane(tmux, rightPane, launchAfter.trim(), 30_000);
    await delay(3_500);
    await tmux(["detach-client", "-s", session]).catch(() => {});
    await attachedExit;
  } finally {
    await tmux(["kill-session", "-t", session]).catch(() => {});
  }
}

async function split() {
  const state = await loadState();
  if (!interactive) throw new Error("Split-screen mode requires an interactive terminal.");
  await command("tmux", ["-V"]);

  const session = `relayfile-demo-${state.runId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const socket = `rf-${state.runId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const tmux = (args, options) => command("tmux", ["-L", socket, ...args], options);
  const columns = Math.max(process.stdout.columns || 180, 140);
  const rows = Math.max(process.stdout.rows || 46, 36);
  await tmux(["new-session", "-d", "-s", session, "-x", String(columns), "-y", String(rows), "-c", root, "/bin/bash --noprofile --norc"]);
  try {
    await tmux(["set-option", "-t", session, "status", "off"]);
    await tmux(["set-option", "-t", session, "pane-border-status", "top"]);
    await tmux(["set-option", "-t", session, "pane-border-format", " #{pane_title} "]);
    await tmux(["set-option", "-t", session, "pane-border-style", "fg=colour8"]);
    await tmux(["set-option", "-t", session, "pane-active-border-style", "fg=colour14"]);
    await tmux(["select-pane", "-t", `${session}:0.0`, "-T", "LAPTOP · UNCOMMITTED FILE"]);
    await tmux(["split-window", "-h", "-p", "48", "-t", `${session}:0`, "-c", root, "/bin/bash --noprofile --norc"]);
    await tmux(["select-pane", "-t", `${session}:0.1`, "-T", "RELAYFILE ↔ DAYTONA"]);
    for (const pane of [0, 1]) {
      await tmux(["send-keys", "-t", `${session}:0.${pane}`, "export PS1='$ '; clear", "Enter"]);
    }
    await tmux(["select-pane", "-t", `${session}:0.0`]);

    const attached = spawn("tmux", ["-L", socket, "attach-session", "-t", session], { stdio: "inherit" });
    const attachedExit = new Promise((resolve, reject) => {
      attached.once("error", reject);
      attached.once("exit", resolve);
    });
    await delay(700);
    await tmux(["send-keys", "-t", `${session}:0.1`, "./demo events", "Enter"]);
    const readyDeadline = Date.now() + 60_000;
    while (Date.now() < readyDeadline) {
      await delay(250);
      const { stdout: eventsScreen } = await tmux(["capture-pane", "-p", "-t", `${session}:0.1`]);
      if (eventsScreen.includes("SUBSCRIBED  WebSocket live")) break;
      if (eventsScreen.includes("Demo failed:")) throw new Error("The Relayfile event pane failed to start.");
    }
    const { stdout: readyScreen } = await tmux(["capture-pane", "-p", "-t", `${session}:0.1`]);
    if (!readyScreen.includes("SUBSCRIBED  WebSocket live")) {
      throw new Error("Timed out waiting for the Relayfile event pane.");
    }
    await tmux(["send-keys", "-t", `${session}:0.0`, "./demo show", "Enter"]);
    await tmux(["select-pane", "-t", `${session}:0.0`]);

    const deadline = Date.now() + 12 * 60_000;
    while (Date.now() < deadline) {
      await delay(500);
      const { stdout: screen } = await tmux(["capture-pane", "-p", "-t", `${session}:0.0`]);
      if (screen.includes("NO COMMIT · NO PUSH · NO PR")) {
        await delay(3_000);
        await tmux(["detach-client", "-s", session]).catch(() => {});
        break;
      }
    }
    await attachedExit;
  } finally {
    await tmux(["kill-session", "-t", session]).catch(() => {});
  }
}

async function main() {
  let shouldCleanup = false;
  try {
    if (action === "prep") {
      await prepare();
      return;
    }
    if (action === "watch") {
      await watch();
      return;
    }
    if (action === "events") {
      await events();
      return;
    }
    if (action === "tail") {
      await tailInDaytona();
      return;
    }
    if (action === "split") {
      await split();
      return;
    }
    if (action === "clean") {
      await preflight();
      runtime = await loadState(false);
      await cleanup(runtime);
      console.log("Demo agent, sandbox, state, and draft cleaned up.");
      return;
    }
    if (action === "show") {
      shouldCleanup = true;
      await show();
      return;
    }
    if (action === "run") {
      shouldCleanup = true;
      await prepare();
      await pause("to connect to Daytona and tail the file");
      await tailInDaytona();
      return;
    }
    throw new Error(`Unknown action: ${action}`);
  } catch (error) {
    if (action !== "watch") shouldCleanup = true;
    console.error(`\nDemo failed: ${error.message}`);
    console.error("First run? Use ./demo setup");
    process.exitCode = 1;
  } finally {
    if (shouldCleanup) await cleanup(runtime);
  }
}

if (action !== "watch") {
  const stop = async (code) => {
    if (!prepared || action !== "prep") await cleanup(runtime);
    process.exit(code);
  };
  process.once("SIGINT", () => void stop(130));
  process.once("SIGTERM", () => void stop(143));
}

await main();
