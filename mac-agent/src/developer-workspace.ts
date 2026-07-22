import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ChatbotJob } from "../../lib/chatbot/protocol";

type DeveloperWorkspaceOptions = {
  githubReadConfigDir: string;
  githubRepositories: string[];
  githubWorktreeRoot: string;
  githubWriteConfigDir: string;
  signal?: AbortSignal;
};

export type DeveloperWorkspace = {
  directory: string;
  environment: Record<string, string>;
  cleanup: () => Promise<void>;
};

function developerMode(job: ChatbotJob) {
  if (job.executionMode === "dev-read" || job.executionMode === "dev-write") {
    return job.executionMode;
  }
  throw new Error("Developer workspace requested for a non-development job.");
}

function safeJobId(jobId: string) {
  if (!/^[a-z0-9._-]{1,128}$/iu.test(jobId)) {
    throw new Error("Developer job ID is not filesystem-safe.");
  }
  return jobId;
}

function selectedRepository(job: ChatbotJob, repositories: string[]) {
  const repository = repositories.find(
    (candidate) =>
      candidate.toLocaleLowerCase("en-US") ===
      job.repository?.toLocaleLowerCase("en-US"),
  );
  if (!repository) {
    throw new Error("The selected repository is not available on this worker.");
  }
  return repository;
}

type RunCommand = (
  command: string[],
  environment: Record<string, string>,
  signal?: AbortSignal,
) => Promise<void>;

async function run(
  command: string[],
  environment: Record<string, string>,
  signal?: AbortSignal,
) {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  });
  const stop = () => child.kill();
  signal?.addEventListener("abort", stop, { once: true });
  const [, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  signal?.removeEventListener("abort", stop);
  if (signal?.aborted) {
    throw new Error("Repository preparation was cancelled.");
  }
  if (exitCode !== 0) {
    throw new Error(
      stderr.trim().split("\n").at(-1) ||
        `Repository preparation exited with status ${exitCode}.`,
    );
  }
}

export async function prepareDeveloperWorkspace(
  job: ChatbotJob,
  options: DeveloperWorkspaceOptions,
  runCommand: RunCommand = run,
): Promise<DeveloperWorkspace> {
  const mode = developerMode(job);
  const repository = selectedRepository(job, options.githubRepositories);
  const jobRoot = resolve(options.githubWorktreeRoot, safeJobId(job.id));
  const directory = join(jobRoot, ...repository.split("/"));
  const githubConfigDir =
    mode === "dev-write"
      ? options.githubWriteConfigDir
      : options.githubReadConfigDir;
  const environment = {
    GH_CONFIG_DIR: githubConfigDir,
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
  };

  await rm(jobRoot, { recursive: true, force: true });
  await mkdir(jobRoot, { recursive: true, mode: 0o700 });
  try {
    await runCommand(
      [
        "gh",
        "repo",
        "clone",
        repository,
        directory,
        "--",
        "--filter=blob:none",
      ],
      environment,
      options.signal,
    );
    if (mode === "dev-write") {
      await runCommand(
        [
          "git",
          "-C",
          directory,
          "switch",
          "-c",
          `minisago/${safeJobId(job.id)}`,
        ],
        environment,
        options.signal,
      );
    }
  } catch (error) {
    await rm(jobRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    directory,
    environment,
    cleanup: () => rm(jobRoot, { recursive: true, force: true }),
  };
}
