import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import type { ChatbotJob } from "../../lib/chatbot/protocol";

const RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MAX_DATABASE_BYTES = 250 * 1024 * 1024;

type TraceRow = {
  purpose: string;
  input_json: string;
  output: string | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
  model: string;
  prompt_version: number;
};

type TraceStoreMetadata = {
  model?: string;
  promptVersion?: number;
};

type ContextPlan = {
  task?: string;
  subject?: string;
  history?: "local" | "medium" | "extended";
  queries?: Array<Record<string, unknown>>;
};

function safeJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function cleanUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function sanitizedJob(job: ChatbotJob): ChatbotJob {
  const sanitizeMessage = (
    message: ChatbotJob["messages"][number],
  ): ChatbotJob["messages"][number] => ({
    ...message,
    attachments: message.attachments.map((attachment) => ({
      ...attachment,
      url: cleanUrl(attachment.url),
    })),
    referencedMessage: message.referencedMessage
      ? sanitizeMessage(message.referencedMessage)
      : undefined,
  });

  return {
    ...job,
    requestMessage: job.requestMessage
      ? sanitizeMessage(job.requestMessage)
      : undefined,
    messages: job.messages.map(sanitizeMessage),
    searchResults: job.searchResults?.map(sanitizeMessage),
  };
}

function queryDescription(query: Record<string, unknown>) {
  const details: string[] = [];
  if (typeof query.content === "string")
    details.push(`關鍵字「${query.content}」`);
  if (typeof query.author === "string") details.push(`作者 ${query.author}`);
  if (Array.isArray(query.has) && query.has.length > 0) {
    details.push(`類型 ${query.has.join("、")}`);
  }
  if (typeof query.embedType === "string")
    details.push(`${query.embedType} 媒體`);
  if (typeof query.linkHostname === "string")
    details.push(`${query.linkHostname} 連結`);
  if (typeof query.attachmentExtension === "string") {
    details.push(`${query.attachmentExtension} 附件`);
  }
  return details.join("、") || "一組結構化條件";
}

function elapsedDescription(rows: TraceRow[]) {
  const started = Math.min(...rows.map((row) => row.started_at));
  const finished = Math.max(
    ...rows.map((row) => row.finished_at ?? row.started_at),
  );
  const seconds = Math.max(0, finished - started) / 1_000;
  return seconds < 1 ? "不到 1 秒" : `大約 ${seconds.toFixed(1)} 秒`;
}

export class ChatbotTraceStore {
  private readonly database: Database;
  private lastCleanup = 0;

  constructor(
    path: string,
    private readonly metadata: TraceStoreMetadata = {},
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.database.exec(
      "PRAGMA journal_mode = DELETE; PRAGMA secure_delete = ON;",
    );
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS chatbot_trace_jobs (
        job_id TEXT PRIMARY KEY,
        request_message_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output TEXT,
        error TEXT,
        model TEXT NOT NULL,
        prompt_version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chatbot_trace_request
        ON chatbot_trace_jobs(request_message_id, started_at);
      CREATE INDEX IF NOT EXISTS chatbot_trace_channel
        ON chatbot_trace_jobs(channel_id, finished_at DESC);
    `);
    this.cleanup();
  }

  start(job: ChatbotJob, now = Date.now()) {
    this.cleanupIfNeeded(now);
    this.database
      .query(
        `INSERT OR REPLACE INTO chatbot_trace_jobs
          (job_id, request_message_id, channel_id, purpose, started_at, status,
           input_json, model, prompt_version)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(
        job.id,
        job.requestMessageId,
        job.channelId,
        job.purpose ?? "answer",
        now,
        JSON.stringify(sanitizedJob(job)),
        this.metadata.model ?? "unknown",
        this.metadata.promptVersion ?? 0,
      );
    if (this.databaseBytes() > MAX_DATABASE_BYTES) this.cleanup(now);
  }

  finish(jobId: string, output: string, now = Date.now()) {
    this.database
      .query(
        `UPDATE chatbot_trace_jobs
         SET finished_at = ?, status = 'complete', output = ?, error = NULL
         WHERE job_id = ?`,
      )
      .run(now, output, jobId);
    if (this.databaseBytes() > MAX_DATABASE_BYTES) this.cleanup(now);
  }

  fail(jobId: string, error: string, now = Date.now()) {
    this.database
      .query(
        `UPDATE chatbot_trace_jobs
         SET finished_at = ?, status = 'failed', error = ?
         WHERE job_id = ?`,
      )
      .run(now, error.slice(0, 2_000), jobId);
    if (this.databaseBytes() > MAX_DATABASE_BYTES) this.cleanup(now);
  }

  explainPrevious(channelId: string, currentRequestMessageId: string) {
    const previous = this.database
      .query(
        `SELECT request_message_id
         FROM chatbot_trace_jobs
         WHERE channel_id = ? AND request_message_id != ?
           AND purpose IN ('answer', 'identity_resolution')
           AND status = 'complete'
         ORDER BY finished_at DESC
         LIMIT 1`,
      )
      .get(channelId, currentRequestMessageId) as {
      request_message_id: string;
    } | null;

    if (!previous) {
      return "我找不到這個頻道上一則回答的決策紀錄 可能已經超過保留期限或是在紀錄功能開啟前回答的";
    }

    const rows = this.database
      .query(
        `SELECT purpose, input_json, output, error, started_at, finished_at,
                model, prompt_version
         FROM chatbot_trace_jobs
         WHERE request_message_id = ?
         ORDER BY started_at`,
      )
      .all(previous.request_message_id) as TraceRow[];
    const planner = rows.find((row) => row.purpose === "context_plan");
    const terminal = [...rows]
      .reverse()
      .find((row) => ["answer", "identity_resolution"].includes(row.purpose));
    const plan = safeJson<ContextPlan>(planner?.output ?? null);
    const answerJob = safeJson<ChatbotJob>(terminal?.input_json ?? null);
    const historyLabel = !plan
      ? "直接讀取這個對話最近的訊息"
      : plan.history === "extended"
        ? "擴大到最多 100 則同頻道訊息"
        : plan.history === "medium"
          ? "擴大到最多 50 則同頻道訊息"
          : "使用附近最多 20 則訊息";
    const contextCount = answerJob?.messages.length ?? 0;
    const searchCount = answerJob?.searchResults?.length ?? 0;
    const queries = plan?.queries ?? [];
    const parts = [
      `我剛剛先${historyLabel} 實際交給回答階段的是 ${contextCount} 則`,
    ];

    if (queries.length > 0) {
      const examples = queries.slice(0, 2).map(queryDescription).join(" 還有 ");
      parts.push(
        `另外用了 ${queries.length} 組條件搜尋伺服器紀錄 包含${examples} 最後帶回 ${searchCount} 則符合的訊息`,
      );
    } else {
      parts.push("規劃後判斷不用另外搜尋伺服器舊訊息");
    }

    if (terminal?.purpose === "identity_resolution") {
      const verdict = safeJson<{ confidence?: string; basis?: string }>(
        terminal.output,
      );
      parts.push(
        `這題走的是身分證據判定 結果信心是 ${verdict?.confidence ?? "unknown"} 依據類型是 ${verdict?.basis ?? "none"}`,
      );
    } else {
      parts.push("接著模型只根據這批內容和當次問題整理成回答");
    }

    parts.push(`整個可觀察到的流程花了${elapsedDescription(rows)}`);
    if (terminal) {
      parts.push(
        `當時使用 ${terminal.model} 和第 ${terminal.prompt_version} 版提示`,
      );
    }
    return `${parts.join("\n")}\n這是我留下的決策軌跡摘要 不包含私密思考逐字稿`;
  }

  cleanup(now = Date.now()) {
    const cutoff = now - RETENTION_MS;
    let deleted = this.database
      .query("DELETE FROM chatbot_trace_jobs WHERE started_at < ?")
      .run(cutoff).changes;

    while (this.databaseBytes() > MAX_DATABASE_BYTES) {
      const result = this.database
        .query(
          `DELETE FROM chatbot_trace_jobs
           WHERE request_message_id IN (
             SELECT request_message_id FROM chatbot_trace_jobs
             GROUP BY request_message_id ORDER BY MIN(started_at) LIMIT 25
           )`,
        )
        .run();
      deleted += result.changes;
      if (result.changes === 0) break;
    }
    if (deleted > 0) this.database.exec("VACUUM");
    this.lastCleanup = now;
  }

  close() {
    this.database.close();
  }

  private cleanupIfNeeded(now: number) {
    if (now - this.lastCleanup >= CLEANUP_INTERVAL_MS) this.cleanup(now);
  }

  private databaseBytes() {
    const pageCount = this.database.query("PRAGMA page_count").get() as {
      page_count: number;
    };
    const freePages = this.database.query("PRAGMA freelist_count").get() as {
      freelist_count: number;
    };
    const pageSize = this.database.query("PRAGMA page_size").get() as {
      page_size: number;
    };
    return (
      (pageCount.page_count - freePages.freelist_count) * pageSize.page_size
    );
  }
}
