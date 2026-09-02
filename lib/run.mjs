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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function indent(value) {
  return value.trimEnd().split("\n").map((line) => `  ${line}`).join("\n");
}

function shortHash(value) {
  return `${value.slice(0, 12)}…`;
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
  const { stdout } = await command("agent-relay", ["workspace", "active", "--json"]);
  const active = parseJsonOutput(stdout);
  if (expectedWorkspaceId && active.relayfileWorkspaceId !== expectedWorkspaceId) {
    throw new Error("The active Relayfile workspace changed after prep. Switch it back or run ./demo clean.");
  }
  const { RelayfileSetup } = await import(pathToFileURL(process.env.RELAYFILE_SDK_ENTRY).href);
  const setup = RelayfileSetup.fromCloudTokens(auth, { cloudApiUrl: active.apiUrl });
  const workspace = await setup.joinWorkspace(active.relayfileWorkspaceId, {
    agentName: "relayfile-live-review-demo",
    scopes: ["fs:read", "fs:write"],
  });
  return { client: workspace.client(), workspaceId: workspace.workspaceId };
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
    "--no-confirm",
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

  console.log(`${colors.bold}PREP${colors.reset}  Starting a fresh ${sandboxProvider.toUpperCase()} reviewer…`);
  const { client, workspaceId } = await relayfileClient();
  const runId = `refund-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  runtime = {
    version: 1,
    runId,
    remoteRoot: `/live-review/${runId}`,
    reviewer: `reviewer-${runId}`,
    workspaceId,
    startedCommit: await gitHead(),
    firstHash: sha256(unsafeCode),
  };

  await fs.writeFile(examplePath, unsafeCode);
  const prompt = (await fs.readFile(promptPath, "utf8")).replaceAll("{{ROOT}}", `.${runtime.remoteRoot}`);
  const watcher = await fs.readFile(watcherPath, "utf8");
  await publish(client, workspaceId, [
    { path: `${runtime.remoteRoot}/refund.js`, content: unsafeCode },
    { path: `${runtime.remoteRoot}/reviewer.md`, content: prompt },
    { path: `${runtime.remoteRoot}/reviewer-watch.sh`, content: watcher },
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
  console.log(`${colors.green}READY${colors.reset} The cloud reviewer is watching the exact uncommitted file.`);
  console.log("\nFor the live reveal:");
  console.log(`  terminal 1  ${colors.bold}./demo show${colors.reset}`);
  console.log(`  terminal 2  ${colors.bold}./demo watch${colors.reset}  ${colors.dim}(optional)${colors.reset}`);
  return runtime;
}

async function show(state) {
  await preflight();
  state ??= await loadState();
  runtime = state;
  const currentCode = await fs.readFile(examplePath, "utf8");
  if (sha256(currentCode) !== state.firstHash) {
    throw new Error("The prepped local file changed. Run ./demo clean and prep again.");
  }
  const { client, workspaceId } = await relayfileClient(state.workspaceId);
  if (interactive && !process.env.RELAYFILE_DEMO_NO_CLEAR) process.stdout.write("\u001b[2J\u001b[H");

  console.log(`${colors.bold}Review the live file. There is no PR yet.${colors.reset}\n`);
  const status = (await command("git", ["status", "--short", "--", "example/refund.js"], { cwd: root })).stdout.trim();
  console.log(`${colors.cyan}LAPTOP${colors.reset}  ${colors.yellow}${status}${colors.reset}`);
  console.log(indent(currentCode));
  const providerLabel = (state.sandbox.provider || "daytona").toUpperCase();
  console.log(`\n${colors.cyan}${providerLabel} REVIEWER${colors.reset}`);
  console.log(indent(reviewSummary(state.review)));
  console.log(`  exact bytes  ${shortHash(state.firstHash)} = ${shortHash(reviewHash(state.review))}  ✓`);

  await pause("to add the authorization check");
  await fs.writeFile(examplePath, fixedCode);
  console.log(`\n${colors.cyan}LAPTOP → RELAYFILE${colors.reset}  same uncommitted file, fixed`);
  console.log(indent(fixedCode));
  const secondHash = sha256(fixedCode);
  const started = performance.now();
  process.stdout.write("  relaying exact bytes to the waiting reviewer…");
  await publish(client, workspaceId, [
    { path: `${state.remoteRoot}/refund.js`, content: fixedCode },
  ]);

  const approval = await waitFor(client, workspaceId, `${state.remoteRoot}/approved.md`);
  const reactedMs = Math.round(performance.now() - started);
  process.stdout.write("\r\u001b[2K");
  if (!approval.startsWith("APPROVED")) throw new Error("Expected APPROVED verdict.");
  if (reviewHash(approval) !== secondHash) throw new Error("Approval SHA-256 did not match the laptop bytes.");

  console.log(`${colors.cyan}${providerLabel} → LAPTOP${colors.reset}`);
  console.log(`${colors.green}${indent(reviewSummary(approval))}${colors.reset}`);
  console.log(`  exact bytes  ${shortHash(secondHash)} = ${shortHash(reviewHash(approval))}  ✓`);
  console.log(`  reviewer reacted in ${(reactedMs / 1000).toFixed(1)}s`);

  const finishedCommit = await gitHead();
  if (finishedCommit !== state.startedCommit) throw new Error("Git HEAD changed during the demo.");
  console.log(`\n${colors.bold}NO COMMIT · NO PUSH · NO PR${colors.reset}`);
  console.log(`${colors.green}The cloud agent reviewed the exact bytes while the developer was still working.${colors.reset}`);
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
      const state = await prepare();
      await pause("to start the live reveal");
      await show(state);
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
