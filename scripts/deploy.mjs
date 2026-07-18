import { execFileSync, spawnSync } from "node:child_process";

const service = "minisago";
const remoteHost = process.env.PLATFORM_HOST ?? "platform";
const remoteDeployRoot =
  process.env.PLATFORM_INFRA_ROOT ?? "/srv/platform/infra";

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
run("ssh", [remoteHost, `${remoteDeployRoot}/scripts/deploy-${service}`]);
