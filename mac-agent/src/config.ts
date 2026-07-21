import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type MacAgentConfig = {
  bridgeUrl: string;
  bridgeSecret: string;
  codexHome: string;
  codexPath: string;
  sessionMonitorPath: string;
  traceDatabasePath: string;
};

const bundledCodexPath = "/Applications/ChatGPT.app/Contents/Resources/codex";
const defaultApplicationSupport = join(
  homedir(),
  "Library",
  "Application Support",
  "MiniSago",
);

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

function validateBridgeUrl(value: string) {
  const url = new URL(value);
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);

  if (url.protocol !== "wss:" && !(isLocal && url.protocol === "ws:")) {
    throw new Error("MINISAGO_BRIDGE_URL must use wss:// unless it is local.");
  }

  return url.toString();
}

export async function loadMacAgentConfig(): Promise<MacAgentConfig> {
  const bridgeSecret = process.env.MINISAGO_MAC_BRIDGE_SECRET?.trim();

  if (!bridgeSecret || Buffer.byteLength(bridgeSecret) < 32) {
    throw new Error(
      "MINISAGO_MAC_BRIDGE_SECRET must contain at least 32 bytes.",
    );
  }

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
    sessionMonitorPath:
      process.env.MINISAGO_SESSION_MONITOR_PATH?.trim() ||
      join(defaultApplicationSupport, "bin", "session-monitor"),
    traceDatabasePath:
      process.env.MINISAGO_TRACE_DATABASE_PATH?.trim() ||
      join(defaultApplicationSupport, "traces.sqlite"),
  };
}
