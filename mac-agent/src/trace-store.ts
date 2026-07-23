import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import type {
  ChatbotJob,
  ChatbotTraceContext,
} from "../../lib/chatbot/protocol";

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
  historyCount?: number;
  history?: "local" | "medium" | "extended";
  memberQueries?: string[];
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

function elapsedMs(rows: TraceRow[]) {
  const started = Math.min(...rows.map((row) => row.started_at));
  const finished = Math.max(
    ...rows.map((row) => row.finished_at ?? row.started_at),
  );
  return Math.max(0, finished - started);
}

function sanitizedSearchQuery(query: Record<string, unknown>) {
  return Object.fromEntries(
    [
      "author",
      "mentions",
      "content",
      "has",
      "embedType",
      "linkHostname",
      "attachmentExtension",
      "sortBy",
      "sortOrder",
    ].flatMap((key) => {
      const value = query[key];
      if (typeof value === "string") return [[key, value.slice(0, 200)]];
      if (Array.isArray(value)) {
        return [
          [
            key,
            value
              .filter((item): item is string => typeof item === "string")
              .slice(0, 8)
              .map((item) => item.slice(0, 100)),
          ],
        ];
      }
      return [];
    }),
  );
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

  start(job: ChatbotJob, now = Date.now(), metadata: TraceStoreMetadata = {}) {
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
        metadata.model ?? this.metadata.model ?? "unknown",
        metadata.promptVersion ?? this.metadata.promptVersion ?? 0,
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

  previousTrace(
    channelId: string,
    currentRequestMessageId: string,
  ): ChatbotTraceContext | undefined {
    const previous = this.database
      .query(
        `SELECT request_message_id
         FROM chatbot_trace_jobs
         WHERE channel_id = ? AND request_message_id != ?
           AND purpose = 'answer'
           AND status = 'complete'
         ORDER BY finished_at DESC
         LIMIT 1`,
      )
      .get(channelId, currentRequestMessageId) as {
      request_message_id: string;
    } | null;

    if (!previous) return undefined;

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
      .find((row) => row.purpose === "answer");
    const plan = safeJson<ContextPlan>(planner?.output ?? null);
    const answerJob = safeJson<ChatbotJob>(terminal?.input_json ?? null);
    const legacyHistoryCount =
      plan?.history === "extended"
        ? 100
        : plan?.history === "medium"
          ? 50
          : plan?.history === "local"
            ? 20
            : undefined;
    return {
      ...((typeof plan?.historyCount === "number" || legacyHistoryCount) && {
        historyCount:
          typeof plan?.historyCount === "number"
            ? plan.historyCount
            : legacyHistoryCount,
      }),
      contextMessageCount: answerJob?.messages.length ?? 0,
      searchQueries: (plan?.queries ?? [])
        .slice(0, 4)
        .map(sanitizedSearchQuery),
      searchResultCount: answerJob?.searchResults?.length ?? 0,
      memberQueries: (plan?.memberQueries ?? [])
        .filter((value): value is string => typeof value === "string")
        .slice(0, 4)
        .map((value) => value.slice(0, 100)),
      elapsedMs: elapsedMs(rows),
      ...(terminal?.model ? { model: terminal.model } : {}),
      ...(terminal?.prompt_version !== undefined
        ? { promptVersion: terminal.prompt_version }
        : {}),
    };
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
