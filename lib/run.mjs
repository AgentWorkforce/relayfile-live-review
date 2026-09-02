import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = path.join(root, "example", "refund.template.js");
const examplePath = path.join(root, "example", "refund.js");
const promptPath = path.join(root, "prompts", "reviewer.md");
const present = process.argv.includes("--present") && process.stdin.isTTY;
const startedCommit = await gitHead();
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "relayfile-live-review-"));
const runId = `refund-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const remoteRoot = `/live-review/${runId}`;
const reviewer = `reviewer-${runId}`;
let sandbox = null;
let draftCreated = false;
let cleanupPromise = null;

const colors = process.stdout.isTTY ? {
  bold: "\u001b[1m", blue: "\u001b[36m", green: "\u001b[32m",
  yellow: "\u001b[33m", dim: "\u001b[2m", reset: "\u001b[0m",
} : { bold: "", blue: "", green: "", yellow: "", dim: "", reset: "" };

const unsafeCode = `${(await fs.readFile(templatePath, "utf8")).trimEnd()}

// local draft — not committed
`;

const fixedCode = `export async function refund(request) {
  if (request.user?.role !== "admin") throw new Error("Forbidden");
  return issueRefund(request.orderId, request.amount);
}

// local draft — not committed
`;

function section(place, title) {
  console.log(`\n${colors.bold}${colors.blue}${place}${colors.reset}  ${title}`);
}

function indent(value) {
  return value.trimEnd().split("\n").map((line) => `  ${line}`).join("\n");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function pause(message) {
  if (!present) return;
  process.stdout.write(`${colors.dim}\nPress Enter ${message}…${colors.reset}`);
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once("data", resolve));
  process.stdin.pause();
}

async function gitHead() {
  try {
    return (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  } catch {
    return "no-commit";
  }
}

async function command(program, args, options = {}) {
  return exec(program, args, { maxBuffer: 10 * 1024 * 1024, ...options });
}

function parseJsonOutput(raw) {
  const start = raw.indexOf("{");
  if (start < 0) throw new Error(`Expected JSON output, received: ${raw}`);
  return JSON.parse(raw.slice(start));
}

async function preflight() {
  await command("agent-relay", ["cloud", "whoami"]);
  await command("relayfile", ["workspace", "current"]);
  if (!process.env.RELAYFILE_SDK_ENTRY || !process.env.AGENT_RELAY_CLOUD_ENTRY) {
    throw new Error("Demo package paths were not initialized.");
  }
}

async function relayfileClient() {
  const authPath = path.join(os.homedir(), ".agentworkforce", "relay", "cloud-auth.json");
  const auth = JSON.parse(await fs.readFile(authPath, "utf8"));
  const { stdout } = await command("agent-relay", ["workspace", "active", "--json"]);
  const active = parseJsonOutput(stdout);
  const { RelayfileSetup } = await import(pathToFileURL(process.env.RELAYFILE_SDK_ENTRY).href);
  const setup = RelayfileSetup.fromCloudTokens(auth, { cloudApiUrl: active.apiUrl });
  const workspace = await setup.joinWorkspace(active.relayfileWorkspaceId, {
    agentName: "relayfile-live-review-demo",
    scopes: ["fs:read", "fs:write"],
  });
  return { client: workspace.client(), workspaceId: workspace.workspaceId };
}

async function publish(client, workspaceId, localPath, remotePath) {
  const content = await fs.readFile(localPath, "utf8");
  const before = performance.now();
  const result = await client.bulkWrite({
    workspaceId,
    files: [{ path: remotePath, content }],
  });
  if (result.errorCount) {
    throw new Error(result.errors.map((item) => item.message).join("; "));
  }
  return Math.round(performance.now() - before);
}

async function waitFor(remotePath, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await command("relayfile", ["read", remotePath], { timeout: 15_000 });
      if (stdout.trim()) return stdout;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${remotePath}`);
}

async function spawnReviewer() {
  const args = [
    "fleet", "spawn", "claude", "--sandbox",
    "--sandbox-name", `relayfile-${runId}`,
    "--sandbox-relayfile-path", `${remoteRoot}/**`,
    "--name", reviewer,
    "--task", `Read .${remoteRoot}/reviewer.md and follow it now.`,
  ];
  const { stdout } = await command("agent-relay", args, { timeout: 10 * 60_000 });
  return parseJsonOutput(stdout).sandbox;
}

function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (draftCreated) await fs.rm(examplePath, { force: true });
    if (sandbox) {
      await command("agent-relay", [
        "fleet", "release", reviewer, "--delete-agent", "--reason", "Relayfile demo cleanup",
      ]).catch((error) => console.error(`Agent cleanup warning: ${error.message}`));
      try {
        const cloud = await import(pathToFileURL(process.env.AGENT_RELAY_CLOUD_ENTRY).href);
        await cloud.deleteCloudFleetSandbox({
          cloudWorkspaceId: sandbox.cloudWorkspaceId,
          sandboxId: sandbox.sandboxId,
        });
      } catch (error) {
        console.error(`Sandbox cleanup warning: ${error.message}`);
      }
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  })();
  return cleanupPromise;
}

async function main() {
  await preflight();
  try {
    await fs.access(examplePath);
    throw new Error("example/refund.js already exists; move it aside before running the demo.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const { client, workspaceId } = await relayfileClient();
  const renderedPrompt = (await fs.readFile(promptPath, "utf8")).replaceAll("{{ROOT}}", `.${remoteRoot}`);
  const remotePromptPath = path.join(tempDir, "reviewer.md");
  await fs.writeFile(remotePromptPath, renderedPrompt);

  console.log(`${colors.bold}Relayfile live review${colors.reset}`);
  console.log("A cloud agent will review a file that has never been committed.");
  await pause("create the local draft");

  draftCreated = true;
  await fs.writeFile(examplePath, unsafeCode);
  section("YOUR LAPTOP", "uncommitted refund handler");
  console.log(indent(unsafeCode));
  const firstHash = sha256(unsafeCode);
  const status = (await command("git", ["status", "--short", "--", "example/refund.js"], { cwd: root })).stdout.trim();
  console.log(`${colors.yellow}  git: ${status || "working tree clean"}${colors.reset}`);

  const firstWrite = await publish(client, workspaceId, examplePath, `${remoteRoot}/refund.js`);
  await publish(client, workspaceId, remotePromptPath, `${remoteRoot}/reviewer.md`);
  console.log(`  Relayfile accepted the code update in ${firstWrite} ms.`);

  await pause("provision the reviewer");
  section("DAYTONA", "provisioning a fresh reviewer sandbox");
  sandbox = await spawnReviewer();
  console.log(`  node: ${sandbox.nodeName}`);
  console.log(`  mount: ${remoteRoot}/**`);
  console.log(`\n${colors.bold}Watch in another terminal:${colors.reset}`);
  console.log(`npx --yes agent-relay@11.10.1 node agent attach ${reviewer} --node ${sandbox.nodeName} --mode view`);

  await pause("wait for its first verdict");
  const review = await waitFor(`${remoteRoot}/review.md`);
  section("DAYTONA → LAPTOP", "review arrived through Relayfile");
  console.log(indent(review));
  if (!review.startsWith("REQUEST_CHANGES")) throw new Error("Expected REQUEST_CHANGES verdict.");
  if (!review.includes(`SHA256 ${firstHash}`)) throw new Error("Review SHA-256 did not match the laptop bytes.");
  console.log(`  Exact bytes verified: ${firstHash.slice(0, 16)}…`);

  const watching = await waitFor(`${remoteRoot}/watching.md`);
  if (!watching.startsWith("WATCHING")) throw new Error("Expected WATCHING handshake.");
  console.log("  Reviewer is now watching that exact file for a change.");

  await pause("apply the local fix");
  await fs.writeFile(examplePath, fixedCode);
  section("YOUR LAPTOP", "same uncommitted file, now fixed");
  console.log(indent(fixedCode));
  const secondHash = sha256(fixedCode);
  const secondWrite = await publish(client, workspaceId, examplePath, `${remoteRoot}/refund.js`);
  console.log(`  Relayfile accepted the code update in ${secondWrite} ms.`);

  const approval = await waitFor(`${remoteRoot}/approved.md`);
  section("DAYTONA → LAPTOP", "same reviewer sees the change");
  console.log(indent(approval));
  if (!approval.startsWith("APPROVED")) throw new Error("Expected APPROVED verdict.");
  if (!approval.includes(`SHA256 ${secondHash}`)) throw new Error("Approval SHA-256 did not match the laptop bytes.");
  console.log(`  Exact fixed bytes verified: ${secondHash.slice(0, 16)}…`);

  const finishedCommit = await gitHead();
  console.log(`\n${colors.bold}${colors.green}PASS${colors.reset}`);
  console.log("  Laptop → Daytona: code");
  console.log("  Daytona → laptop: review and approval");
  console.log(`  Git commit unchanged: ${startedCommit === finishedCommit ? "yes" : "NO"}`);
  console.log("  Cleaning up the exact agent and sandbox now.");
}

process.once("SIGINT", async () => { await cleanup(); process.exit(130); });
process.once("SIGTERM", async () => { await cleanup(); process.exit(143); });

try {
  await main();
} catch (error) {
  console.error(`\nDemo failed: ${error.message}`);
  console.error("If this is your first run, use: ./demo setup");
  process.exitCode = 1;
} finally {
  await cleanup();
}
