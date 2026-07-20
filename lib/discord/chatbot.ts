import { randomUUID } from "node:crypto";

import { macAgentBridge } from "../chatbot/bridge";
import type {
  ChatbotAttachment,
  ChatbotJob,
  ChatbotMessage,
} from "../chatbot/protocol";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const AUTHORIZED_USER_ID = "917446775873343600";
const MESSAGE_LIMIT = 100;
const MESSAGE_PAGE_LIMIT = 100;
const MAX_PAGES = 5;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const DISCORD_MESSAGE_LIMIT = 2_000;
const TYPING_REFRESH_MS = 8_000;

type DiscordAttachment = {
  id: string;
  filename: string;
  content_type?: string;
  size: number;
  url: string;
};

type DiscordMessage = {
  id: string;
  channel_id: string;
  guild_id?: string;
  content?: string;
  timestamp: string;
  webhook_id?: string;
  author?: {
    id?: string;
    username?: string;
    global_name?: string | null;
    bot?: boolean;
  };
  attachments?: DiscordAttachment[];
  embeds?: Array<{
    title?: string;
    description?: string;
    url?: string;
  }>;
  sticker_items?: Array<{ name?: string }>;
  referenced_message?: DiscordMessage | null;
};

type DiscordRequest = <T>(
  path: string,
  options?: { method?: string; body?: unknown },
) => Promise<T>;

export type ChatbotMention = DiscordMessage;

function authorName(message: DiscordMessage) {
  return (
    message.author?.global_name ||
    message.author?.username ||
    message.author?.id ||
    "Unknown user"
  );
}

function attachment(attachment: DiscordAttachment): ChatbotAttachment {
  return {
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.content_type,
    size: attachment.size,
    url: attachment.url,
  };
}

function messageContent(message: DiscordMessage) {
  const parts = [message.content?.trim() ?? ""];

  for (const embed of message.embeds ?? []) {
    parts.push(
      [embed.title, embed.description, embed.url].filter(Boolean).join("\n"),
    );
  }

  for (const sticker of message.sticker_items ?? []) {
    if (sticker.name) {
      parts.push(`[Sticker: ${sticker.name}]`);
    }
  }

  return parts.filter(Boolean).join("\n");
}

function contextMessage(
  message: DiscordMessage,
): Omit<ChatbotMessage, "referencedMessage"> {
  return {
    id: message.id,
    author: authorName(message),
    timestamp: message.timestamp,
    content: messageContent(message),
    attachments: (message.attachments ?? []).map(attachment),
  };
}

export function toChatbotMessage(message: DiscordMessage): ChatbotMessage {
  return {
    ...contextMessage(message),
    referencedMessage: message.referenced_message
      ? contextMessage(message.referenced_message)
      : undefined,
  };
}

export function isHumanContextMessage(
  message: DiscordMessage,
  requestMessageId: string,
  cutoff: Date,
) {
  return (
    message.id !== requestMessageId &&
    new Date(message.timestamp) >= cutoff &&
    !message.webhook_id &&
    !message.author?.bot
  );
}

export function extractMentionRequest(content: string, botUserId: string) {
  const mentionPattern = new RegExp(`<@!?${botUserId}>`, "g");

  if (!mentionPattern.test(content)) {
    return null;
  }

  return content.replace(mentionPattern, "").trim();
}

export function formatDiscordAnswer(content: string) {
  const normalized = content.trim();

  if (normalized.length <= DISCORD_MESSAGE_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, DISCORD_MESSAGE_LIMIT - 1).trimEnd()}…`;
}

async function getRecentHumanMessages({
  channelId,
  requestMessageId,
  discordRequest,
  now = new Date(),
}: {
  channelId: string;
  requestMessageId: string;
  discordRequest: DiscordRequest;
  now?: Date;
}) {
  const cutoff = new Date(now.getTime() - HISTORY_WINDOW_MS);
  const messages: ChatbotMessage[] = [];
  let before: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const query = new URLSearchParams({ limit: String(MESSAGE_PAGE_LIMIT) });
    if (before) {
      query.set("before", before);
    }

    const page = await discordRequest<DiscordMessage[]>(
      `/channels/${channelId}/messages?${query}`,
    );

    for (const message of page) {
      if (isHumanContextMessage(message, requestMessageId, cutoff)) {
        messages.push(toChatbotMessage(message));
      }

      if (messages.length >= MESSAGE_LIMIT) {
        return messages.slice(0, MESSAGE_LIMIT).reverse();
      }
    }

    const oldestMessage = page.at(-1);
    if (
      page.length < MESSAGE_PAGE_LIMIT ||
      !oldestMessage ||
      new Date(oldestMessage.timestamp) < cutoff
    ) {
      break;
    }

    before = oldestMessage.id;
  }

  return messages.reverse();
}

function replyBody(message: DiscordMessage, content: string) {
  return {
    content,
    message_reference: {
      message_id: message.id,
      fail_if_not_exists: false,
    },
    allowed_mentions: {
      parse: [],
      replied_user: true,
    },
  };
}

async function withTyping<T>(
  channelId: string,
  discordRequest: DiscordRequest,
  task: () => Promise<T>,
) {
  await discordRequest(`/channels/${channelId}/typing`, { method: "POST" });
  const timer = setInterval(() => {
    void discordRequest(`/channels/${channelId}/typing`, {
      method: "POST",
    }).catch(() => undefined);
  }, TYPING_REFRESH_MS);

  try {
    return await task();
  } finally {
    clearInterval(timer);
  }
}

export async function handleChatbotMention({
  message,
  botUserId,
  discordRequest,
}: {
  message: ChatbotMention;
  botUserId: string;
  discordRequest: DiscordRequest;
}) {
  if (
    message.author?.id !== AUTHORIZED_USER_ID ||
    message.author.bot ||
    message.webhook_id ||
    !message.content
  ) {
    return false;
  }

  const request = extractMentionRequest(message.content, botUserId);
  if (request === null) {
    return false;
  }

  if (!request) {
    await discordRequest(`/channels/${message.channel_id}/messages`, {
      method: "POST",
      body: replyBody(message, "What would you like me to help with?"),
    });
    return true;
  }

  const bridgeStatus = macAgentBridge.getStatus();

  if (bridgeStatus === "offline") {
    await discordRequest(`/channels/${message.channel_id}/messages`, {
      method: "POST",
      body: replyBody(message, "My Mac is offline right now."),
    });
    return true;
  }

  if (bridgeStatus === "busy") {
    await discordRequest(`/channels/${message.channel_id}/messages`, {
      method: "POST",
      body: replyBody(message, "I’m busy with another request right now."),
    });
    return true;
  }

  const result = await withTyping(
    message.channel_id,
    discordRequest,
    async () => {
      const job: ChatbotJob = {
        id: randomUUID(),
        channelId: message.channel_id,
        requestMessageId: message.id,
        request,
        messages: await getRecentHumanMessages({
          channelId: message.channel_id,
          requestMessageId: message.id,
          discordRequest,
        }),
      };
      const dispatch = macAgentBridge.dispatch(job);

      if (dispatch.status === "offline") {
        return { ok: false as const, error: "The Mac disconnected." };
      }

      if (dispatch.status === "busy") {
        return { ok: false as const, error: "The Mac became busy." };
      }

      return dispatch.result;
    },
  );
  const content = result.ok
    ? formatDiscordAnswer(result.content)
    : "I couldn’t finish that request. Please try again.";

  await discordRequest(`/channels/${message.channel_id}/messages`, {
    method: "POST",
    body: replyBody(message, content),
  });

  return true;
}

export function createDiscordRequest(botToken: string): DiscordRequest {
  async function discordRequest<T>(
    path: string,
    options: { method?: string; body?: unknown } = {},
    retries = 3,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bot ${botToken}`,
    };

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(`${DISCORD_API_BASE_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (response.status === 429 && retries > 0) {
      const payload = (await response.json()) as { retry_after?: number };
      await Bun.sleep(Math.ceil((payload.retry_after ?? 1) * 1_000));
      return discordRequest<T>(path, options, retries - 1);
    }

    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  return discordRequest;
}
