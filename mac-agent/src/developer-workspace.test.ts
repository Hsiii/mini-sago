import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChatbotJob } from "../../lib/chatbot/protocol";
import { prepareDeveloperWorkspace } from "./developer-workspace";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function options() {
  const root = await mkdtemp(join(tmpdir(), "minisago-dev-workspace-"));
  roots.push(root);
  return {
    githubReadConfigDir: "/secrets/github-read",
    githubRepositories: ["Hsiii/mini-sago"],
    githubWorktreeRoot: join(root, "worktrees"),
    githubWriteConfigDir: "/secrets/github-write",
  };
}

function job(mode: "dev-read" | "dev-write"): ChatbotJob {
  return {
    id: "job-123",
    requesterUserId: "917446775873343600",
    purpose: "answer",
    executionMode: mode,
    repository: "Hsiii/mini-sago",
    channelId: "channel-1",
    requestMessageId: "message-1",
    request: "review the PR",
    messages: [],
  };
}

describe("developer workspace", () => {
  test("clones only the selected repo with the read credential", async () => {
    const commands: Array<{
      command: string[];
      environment: Record<string, string>;
    }> = [];
    const workspace = await prepareDeveloperWorkspace(
      job("dev-read"),
      await options(),
      async (command, environment) => {
        commands.push({ command, environment });
      },
    );

    expect(workspace.directory).toEndWith("/worktrees/job-123/Hsiii/mini-sago");
    expect(commands).toHaveLength(1);
    expect(commands[0]!.command.slice(0, 4)).toEqual([
      "gh",
      "repo",
      "clone",
      "Hsiii/mini-sago",
    ]);
    expect(commands[0]!.environment.GH_CONFIG_DIR).toBe("/secrets/github-read");
    expect(commands[0]!.environment).not.toContainValue(
      "/secrets/github-write",
    );
    await workspace.cleanup();
  });

  test("uses the write credential only for explicit write jobs", async () => {
    const commands: Array<{
      command: string[];
      environment: Record<string, string>;
    }> = [];
    await prepareDeveloperWorkspace(
      job("dev-write"),
      await options(),
      async (command, environment) => {
        commands.push({ command, environment });
      },
    );

    expect(commands).toHaveLength(2);
    expect(
      commands.every(
        ({ environment }) =>
          environment.GH_CONFIG_DIR === "/secrets/github-write",
      ),
    ).toBe(true);
    expect(commands[1]!.command.at(-1)).toBe("minisago/job-123");
  });

  test("rejects a repository outside the worker advertisement", async () => {
    await expect(
      prepareDeveloperWorkspace(
        { ...job("dev-read"), repository: "Hsiii/other" },
        await options(),
        async () => {
          throw new Error("command should not run");
        },
      ),
    ).rejects.toThrow("not available on this worker");
  });
});
