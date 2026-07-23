export const CHATBOT_PROTOCOL_VERSION = 17;
export const CHATBOT_JOB_TIMEOUT_MS = 120_000;
export const CHATBOT_DEV_JOB_TIMEOUT_MS = 15 * 60_000;

export const CHATBOT_WORKER_CAPABILITIES = ["chat", "dev", "mac"] as const;
export type ChatbotWorkerCapability =
  (typeof CHATBOT_WORKER_CAPABILITIES)[number];

export type ChatbotAttachment = {
  id: string;
  filename: string;
  contentType?: string;
  size: number;
  url: string;
};

export type ChatbotReaction = {
  emoji: string;
  count: number;
  me?: boolean;
};

export type ChatbotExecutionMode = "chat" | "dev";
export type ChatbotExecutionTarget = "default" | "mac";
export type ChatbotMutationScope = "code" | "issue" | "deploy";

export type ChatbotMemberResult = {
  query: string;
  names: string[];
};

export type ChatbotMessage = {
  id: string;
  role?: "user" | "assistant";
  author: string;
  authorAliases?: string[];
  timestamp: string;
  content: string;
  attachments: ChatbotAttachment[];
  reactions?: ChatbotReaction[];
  channelId?: string;
  channelName?: string;
  jumpUrl?: string;
  referencedMessage?: Omit<ChatbotMessage, "referencedMessage">;
};

export type ChatbotJob = {
  id: string;
  requesterUserId: string;
  purpose?: "answer" | "execution_route" | "context_plan" | "trace_explanation";
  executionMode?: ChatbotExecutionMode;
  executionTarget?: ChatbotExecutionTarget;
  mutationScope?: ChatbotMutationScope;
  repository?: string;
  availableRepositories?: string[];
  chatbotRepository?: string;
  channelId: string;
  requestMessageId: string;
  request: string;
  requestMessage?: ChatbotMessage;
  messages: ChatbotMessage[];
  searchStatus?: "not_requested" | "complete" | "unavailable";
  searchResults?: ChatbotMessage[];
  memberLookupStatus?: "not_requested" | "complete" | "unavailable";
  memberResults?: ChatbotMemberResult[];
};

export type MacAgentClientMessage =
  | {
      type: "authenticate";
      protocolVersion: number;
      secret: string;
      workerId: string;
      capabilities: ChatbotWorkerCapability[];
      repositories: string[];
      chatbotRepository?: string;
      priority: number;
    }
  | {
      type: "availability";
      available: boolean;
      capacity: number;
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
