import { access } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { isIP } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";

export type MacAgentConfig = {
  bridgeUrl: string;
  bridgeSecret: string;
  codexHome: string;
  codexPath: string;
  githubConfigDir: string;
  githubRepositories: string[];
  githubWorktreeRoot: string;
  maxConcurrentJobs: number;
  headless: boolean;
  sessionMonitorPath: string;
  traceDatabasePath: string;
  workspaceRoot: string;
  workerCapabilities: Array<"chat" | "dev-read" | "dev-write" | "mac">;
  workerId: string;
  workerPriority: number;
};

const workerCapabilityNames = ["chat", "dev-read", "dev-write", "mac"] as const;

export const defaultWorkerCapabilities = (headless: boolean) =>
  headless ? "chat,dev-read,dev-write" : "chat,dev-read,dev-write,mac";

const bundledCodexPath = "/Applications/ChatGPT.app/Contents/Resources/codex";
const defaultApplicationSupport =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "MiniSago")
    : join(homedir(), ".local", "state", "minisago");

async function isExecutable(path: string) {
  try {
    await access(path, 1);
    return true;
  } catch {
    return false;
  }
}

async function resolveCodexPath() {
  const configured = process.env.MINISAGO_CODEX_PATH?.trim();
  const candidates = [configured, bundledCodexPath, Bun.which("codex")].filter(
    (candidate): candidate is string => Boolean(candidate),
  );

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "No working Codex executable was found. Set MINISAGO_CODEX_PATH.",
  );
}

export function validateBridgeUrl(value: string) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const ipVersion = isIP(hostname);
  const isLocal =
    ["localhost", "127.0.0.1", "::1"].includes(hostname) ||
    (ipVersion === 0 && !hostname.includes(".") && !hostname.includes(":"));

  if (url.protocol !== "wss:" && !(isLocal && url.protocol === "ws:")) {
    throw new Error(
      "MINISAGO_BRIDGE_URL must use wss:// unless it is local or container-local.",
    );
  }

  return url.toString();
}

export function workspaceChild(root: string, candidate: string, name: string) {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  const pathFromRoot = relative(absoluteRoot, absoluteCandidate);
  if (
    !pathFromRoot ||
    pathFromRoot.startsWith("..") ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(
      `${name} must be a directory inside MINISAGO_WORKSPACE_ROOT.`,
    );
  }
  return absoluteCandidate;
}

export async function loadMacAgentConfig(): Promise<MacAgentConfig> {
  const bridgeSecret = process.env.MINISAGO_MAC_BRIDGE_SECRET?.trim();

  if (!bridgeSecret || Buffer.byteLength(bridgeSecret) < 32) {
    throw new Error(
      "MINISAGO_MAC_BRIDGE_SECRET must contain at least 32 bytes.",
    );
  }

  const headless =
    process.env.MINISAGO_HEADLESS === "true" || process.platform !== "darwin";
  const defaultWorkerId = `${headless ? "cloud" : "mac"}-${hostname()}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .slice(0, 64);
  const workerId = process.env.MINISAGO_WORKER_ID?.trim() || defaultWorkerId;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(workerId)) {
    throw new Error("MINISAGO_WORKER_ID must be a safe 1-64 character ID.");
  }
  const configuredCapabilities = (
    process.env.MINISAGO_WORKER_CAPABILITIES ||
    defaultWorkerCapabilities(headless)
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const workerCapabilities = workerCapabilityNames.filter((capability) =>
    configuredCapabilities.includes(capability),
  );
  if (
    workerCapabilities.length === 0 ||
    workerCapabilities.length !== new Set(configuredCapabilities).size
  ) {
    throw new Error(
      "MINISAGO_WORKER_CAPABILITIES must contain only chat, dev-read, dev-write, and mac.",
    );
  }
  const githubRepositories = (process.env.MINISAGO_GITHUB_REPOSITORIES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    githubRepositories.some(
      (repository) => !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/iu.test(repository),
    )
  ) {
    throw new Error(
      "MINISAGO_GITHUB_REPOSITORIES must contain owner/repository names.",
    );
  }
  if (
    githubRepositories.length === 0 &&
    workerCapabilities.some((capability) => capability.startsWith("dev-"))
  ) {
    throw new Error(
      "MINISAGO_GITHUB_REPOSITORIES is required for dev-read or dev-write workers.",
    );
  }
  const workspaceRoot =
    process.env.MINISAGO_WORKSPACE_ROOT?.trim() || join(homedir(), "Projects");
  const githubWorktreeRoot = workspaceChild(
    workspaceRoot,
    process.env.MINISAGO_GITHUB_WORKTREE_ROOT?.trim() ||
      join(workspaceRoot, "worktrees"),
    "MINISAGO_GITHUB_WORKTREE_ROOT",
  );

  return {
    bridgeUrl: validateBridgeUrl(
      process.env.MINISAGO_BRIDGE_URL?.trim() ||
        "wss://bot.hsichen.dev/api/mac-agent/ws",
    ),
    bridgeSecret,
    codexHome:
      process.env.MINISAGO_CODEX_HOME?.trim() ||
      join(defaultApplicationSupport, "codex-home"),
    codexPath: await resolveCodexPath(),
    githubConfigDir:
      process.env.MINISAGO_GITHUB_CONFIG_DIR?.trim() ||
      join(defaultApplicationSupport, "github"),
    githubRepositories,
    githubWorktreeRoot,
    headless,
    maxConcurrentJobs: Math.max(
      1,
      Math.min(
        16,
        Number.parseInt(process.env.MINISAGO_MAX_CONCURRENT_JOBS || "2", 10) ||
          2,
      ),
    ),
    sessionMonitorPath:
      process.env.MINISAGO_SESSION_MONITOR_PATH?.trim() ||
      join(defaultApplicationSupport, "bin", "session-monitor"),
    traceDatabasePath:
      process.env.MINISAGO_TRACE_DATABASE_PATH?.trim() ||
      join(defaultApplicationSupport, "traces.sqlite"),
    workspaceRoot,
    workerCapabilities,
    workerId,
    workerPriority: Math.max(
      0,
      Math.min(
        1_000,
        Number.parseInt(
          process.env.MINISAGO_WORKER_PRIORITY || (headless ? "100" : "50"),
          10,
        ) || 0,
      ),
    ),
  };
}
