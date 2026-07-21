export const CHATBOT_PROTOCOL_VERSION = 9;
export const CHATBOT_JOB_TIMEOUT_MS = 120_000;

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

export type ChatbotSearchPurpose =
  | "context"
  | "direct_mention"
  | "self_claim"
  | "candidate_check";

export type ChatbotTask = "general" | "identity_resolution";

export type ChatbotIdentityCandidate = {
  names: string[];
};

export type ChatbotIdentityResolution = {
  subject: string;
  candidate?: string;
  confidence: "strong" | "moderate" | "weak" | "unknown";
  basis:
    | "direct_self_link"
    | "discord_member_profile"
    | "independent_corroboration"
    | "third_party_only"
    | "conflicting"
    | "none";
  sourceIndexes: number[];
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
  searchPurposes?: ChatbotSearchPurpose[];
  referencedMessage?: Omit<ChatbotMessage, "referencedMessage">;
};

export type ChatbotJob = {
  id: string;
  purpose?:
    | "answer"
    | "context_plan"
    | "identity_resolution"
    | "trace_explanation";
  task?: ChatbotTask;
  subject?: string;
  identityCandidates?: ChatbotIdentityCandidate[];
  identityResolution?: ChatbotIdentityResolution;
  channelId: string;
  requestMessageId: string;
  request: string;
  requestMessage?: ChatbotMessage;
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
