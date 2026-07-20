export const CHATBOT_PROTOCOL_VERSION = 4;
export const CHATBOT_JOB_TIMEOUT_MS = 120_000;

export type ChatbotAttachment = {
  id: string;
  filename: string;
  contentType?: string;
  size: number;
  url: string;
};

export type ChatbotMessage = {
  id: string;
  author: string;
  timestamp: string;
  content: string;
  attachments: ChatbotAttachment[];
  channelId?: string;
  channelName?: string;
  jumpUrl?: string;
  referencedMessage?: Omit<ChatbotMessage, "referencedMessage">;
};

export type ChatbotJob = {
  id: string;
  purpose?: "answer" | "search_plan";
  channelId: string;
  requestMessageId: string;
  request: string;
  messages: ChatbotMessage[];
  searchStatus?: "not_requested" | "complete" | "unavailable";
  searchResults?: ChatbotMessage[];
};

export type MacAgentClientMessage =
  | {
      type: "authenticate";
      protocolVersion: number;
      secret: string;
    }
  | {
      type: "availability";
      available: boolean;
    }
  | {
      type: "heartbeat";
    }
  | {
      type: "result";
      jobId: string;
      ok: true;
      content: string;
    }
  | {
      type: "result";
      jobId: string;
      ok: false;
      error: string;
    };

export type MacAgentServerMessage =
  | {
      type: "authenticated";
      protocolVersion: number;
    }
  | {
      type: "job";
      job: ChatbotJob;
    }
  | {
      type: "cancel";
      jobId: string;
    };
