import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChatbotJob } from "../../lib/chatbot/protocol";
import { ChatbotTraceStore } from "./trace-store";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function store() {
  const directory = mkdtempSync(join(tmpdir(), "minisago-traces-"));
  directories.push(directory);
  return new ChatbotTraceStore(join(directory, "traces.sqlite"), {
    model: "test-model",
    promptVersion: 7,
  });
}

function job(overrides: Partial<ChatbotJob>): ChatbotJob {
  return {
    id: "answer-1",
    requesterUserId: "test-user",
    purpose: "answer",
    channelId: "channel-1",
    requestMessageId: "request-1",
    request: "What happened?",
    messages: [],
    ...overrides,
  };
}

describe("chatbot trace store", () => {
  test("explains the latest planner and answer stages in plain language", () => {
    const traces = store();
    const planner = job({ id: "planner-1", purpose: "context_plan" });
    const answer = job({
      messages: Array.from({ length: 42 }, (_, index) => ({
        id: `message-${index}`,
        author: "Member",
        timestamp: "2026-07-21T10:00:00.000Z",
        content: "context",
        attachments: [],
      })),
      searchStatus: "complete",
      searchResults: [
        {
          id: "match-1",
          author: "Daniel",
          timestamp: "2026-07-20T10:00:00.000Z",
          content: "the matching message",
          attachments: [],
        },
      ],
    });

    traces.start(planner, 1_000);
    traces.finish(
      planner.id,
      JSON.stringify({
        historyCount: 50,
        queries: [{ content: "launch", author: "Daniel" }],
      }),
      1_500,
    );
    traces.start(answer, 1_600, { model: "owner-model" });
    traces.finish(answer.id, "The answer", 3_000);

    const explanation = traces.explainPrevious("channel-1", "request-2");
    expect(explanation).toContain("最多 50 則");
    expect(explanation).toContain("實際交給回答階段的是 42 則");
    expect(explanation).toContain("關鍵字「launch」、作者 Daniel");
    expect(explanation).toContain("帶回 1 則");
    expect(explanation).toContain("大約 2.0 秒");
    expect(explanation).toContain("owner-model 和第 7 版提示");
    expect(explanation).toContain("不包含私密思考逐字稿");
    traces.close();
  });

  test("deletes traces older than fourteen days", () => {
    const traces = store();
    const oldJob = job({});
    traces.start(oldJob, 1_000);
    traces.finish(oldJob.id, "Old answer", 2_000);
    traces.cleanup(15 * 24 * 60 * 60 * 1_000);

    expect(traces.explainPrevious("channel-1", "request-2")).toContain(
      "找不到這個頻道上一則回答的決策紀錄",
    );
    traces.close();
  });
});
