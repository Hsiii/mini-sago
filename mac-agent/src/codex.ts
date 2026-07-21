import { join } from "node:path";

import type { ChatbotJob } from "../../lib/chatbot/protocol";
import { prepareAttachments } from "./attachments";
import { buildCodexPrompt, outputSchemaForJob } from "./prompts";

export {
  buildCodexPrompt,
  CONTEXT_PLAN_OUTPUT_SCHEMA,
  IDENTITY_RESOLUTION_OUTPUT_SCHEMA,
  outputSchemaForJob,
  PROMPT_VERSION,
} from "./prompts";

const LOCAL_TIMEOUT_MS = 110_000;
export const CHATBOT_MODEL = "gpt-5.6-luna";
export const CHATBOT_REASONING_EFFORT = "high";

type CodexRunOptions = {
  codexHome: string;
  codexPath: string;
  signal?: AbortSignal;
};

function withoutAttachments(message: ChatbotJob["messages"][number]) {
  return {
    ...message,
    attachments: [],
    referencedMessage: message.referencedMessage
      ? { ...message.referencedMessage, attachments: [] }
      : undefined,
  };
}

function escapeSeatbeltLiteral(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildSeatbeltProfile(codexPath: string) {
  return `(version 1)
(allow default)
(deny process-exec)
(allow process-exec (literal "${escapeSeatbeltLiteral(codexPath)}"))`;
}

function codexEnvironment(codexHome: string) {
  const allowedNames = [
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "NO_PROXY",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "SSL_CERT_FILE",
    "TMPDIR",
    "USER",
  ];
  const environment: Record<string, string> = {
    CODEX_HOME: codexHome,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TERM: "dumb",
    NO_COLOR: "1",
  };

  for (const name of allowedNames) {
    const value = process.env[name];
    if (value) {
      environment[name] = value;
    }
  }

  return environment;
}

function parseFinalResponse(output: string) {
  let finalResponse = "";

  for (const line of output.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    const event = JSON.parse(line) as {
      type?: string;
      item?: { type?: string; text?: string };
    };

    if (
      event.item?.type &&
      ["command_execution", "file_change", "mcp_tool_call"].includes(
        event.item.type,
      )
    ) {
      throw new Error("Codex attempted a disabled local tool.");
    }

    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      event.item.text
    ) {
      finalResponse = event.item.text;
    }
  }

  if (!finalResponse.trim()) {
    throw new Error("Codex returned no final answer.");
  }

  return finalResponse.trim();
}

export async function checkCodexAuthentication({
  codexHome,
  codexPath,
}: Pick<CodexRunOptions, "codexHome" | "codexPath">) {
  const process = Bun.spawn([codexPath, "login", "status"], {
    stdout: "ignore",
    stderr: "ignore",
    env: codexEnvironment(codexHome),
  });

  return (await process.exited) === 0;
}

export async function runCodexJob(job: ChatbotJob, options: CodexRunOptions) {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), LOCAL_TIMEOUT_MS);
  const abort = () => timeoutController.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) timeoutController.abort();
  let prepared: Awaited<ReturnType<typeof prepareAttachments>> | undefined;

  try {
    const preparationJob =
      job.purpose === "context_plan"
        ? {
            ...job,
            requestMessage: undefined,
            messages: [],
            searchResults: [],
          }
        : job.purpose === "identity_resolution"
          ? {
              ...job,
              requestMessage: job.requestMessage
                ? withoutAttachments(job.requestMessage)
                : undefined,
              messages: job.messages.map(withoutAttachments),
              searchResults: (job.searchResults ?? []).map(withoutAttachments),
            }
          : job;
    prepared = await prepareAttachments(
      preparationJob,
      timeoutController.signal,
    );
    const prompt = buildCodexPrompt(job, prepared.textBlocks, prepared.ignored);
    const outputSchema = outputSchemaForJob(job);
    const codexArguments = [
      options.codexPath,
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--strict-config",
      "--model",
      CHATBOT_MODEL,
      "--cd",
      prepared.directory,
      "--config",
      `model_reasoning_effort="${CHATBOT_REASONING_EFFORT}"`,
      "--config",
      'model_verbosity="low"',
      "--config",
      'approval_policy="never"',
      "--config",
      'web_search="live"',
      "--config",
      'default_permissions="minisago-chatbot"',
      "--config",
      'permissions.minisago-chatbot.filesystem={":minimal"="read",":workspace_roots"={"."="read"}}',
      "--config",
      "permissions.minisago-chatbot.network.enabled=false",
      "--config",
      "features.hooks=false",
      "--config",
      "features.memories=false",
      "--config",
      "allow_login_shell=false",
    ];

    if (outputSchema) {
      const schemaPath = join(prepared.directory, "output-schema.json");
      await Bun.write(schemaPath, JSON.stringify(outputSchema));
      codexArguments.push("--output-schema", schemaPath);
    }

    for (const imagePath of prepared.imagePaths) {
      codexArguments.push("--image", imagePath);
    }

    codexArguments.push("-");

    const process = Bun.spawn(
      [
        "/usr/bin/sandbox-exec",
        "-p",
        buildSeatbeltProfile(options.codexPath),
        ...codexArguments,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: codexEnvironment(options.codexHome),
      },
    );
    const stop = () => process.kill();
    timeoutController.signal.addEventListener("abort", stop, { once: true });
    process.stdin.write(prompt);
    process.stdin.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);

    if (timeoutController.signal.aborted) {
      throw new Error("Codex request was cancelled or timed out.");
    }

    if (exitCode !== 0) {
      const lastErrorLine = stderr.trim().split("\n").at(-1);
      throw new Error(lastErrorLine || `Codex exited with status ${exitCode}.`);
    }

    return parseFinalResponse(stdout);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    await prepared?.cleanup();
  }
}
