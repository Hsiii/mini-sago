import { execFileSync, spawnSync } from "node:child_process";

const repository = "Hsiii/MiniSago";
const workflow = "image.yml";
const service = "bot-core";
const remoteHost = process.env.PLATFORM_HOST ?? "platform";
const remoteDeployRoot =
  process.env.PLATFORM_OPERATIONS_ROOT ?? "/srv/platform/operations";

function output(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function hasRemote(name) {
  return output("git", ["remote"]).split("\n").includes(name);
}

function waitForImage(commit) {
  let runId = "";

  for (let attempt = 0; attempt < 30 && !runId; attempt += 1) {
    const runs = JSON.parse(
      output("gh", [
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        workflow,
        "--commit",
        commit,
        "--limit",
        "1",
        "--json",
        "databaseId",
      ]),
    );

    runId = runs[0]?.databaseId?.toString() ?? "";
    if (!runId) run("sleep", ["2"]);
  }

  if (!runId) {
    console.error(`No ${workflow} run appeared for ${commit}.`);
    process.exit(1);
  }

  run("gh", ["run", "watch", runId, "--repo", repository, "--exit-status"]);
}

const branch = output("git", ["branch", "--show-current"]);

if (branch !== "main") {
  console.error(
    `Deploy from main. Current branch is ${branch || "(detached)"}.`,
  );
  process.exit(1);
}

if (output("git", ["status", "--porcelain"])) {
  console.error("Commit or stash local changes before deploying.");
  process.exit(1);
}

if (!hasRemote("origin")) {
  console.error("Missing origin remote.");
  process.exit(1);
}

run("git", ["push", "origin", branch]);
const commit = output("git", ["rev-parse", "HEAD"]);
waitForImage(commit);
run("ssh", [remoteHost, `${remoteDeployRoot}/scripts/deploy-${service}`]);
