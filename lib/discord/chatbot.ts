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
const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const SEARCH_RESULT_LIMIT = 25;
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

type DiscordGuildMember = {
  nick?: string | null;
  user?: {
    id?: string;
    username?: string;
    global_name?: string | null;
  };
};

type DiscordChannel = {
  id: string;
  name?: string;
};

type DiscordMessageSearchResponse = {
  code?: number;
  retry_after?: number;
  messages?: DiscordMessage[][];
};

export type MessageSearchPlan = {
  authorQuery: string;
  content?: string;
  has?: "file" | "image" | "link" | "sticker" | "video";
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
) {
  return (
    message.id !== requestMessageId &&
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

const SEARCH_PATTERNS = [
  /\b(?:when|where)\s+did\s+(?<author>.{1,64}?)\s+(?:send|post|share|upload)\s+(?:me\s+)?(?:the\s+|an?\s+)?(?<subject>.+?)[?!.]*$/iu,
  /\b(?:find|show me|repost|resend|link me to)\s+(?:the\s+|an?\s+)?(?<subject>.+?)\s+(?:message\s+)?(?:that\s+)?(?<author>.{1,64}?)\s+(?:sent|posted|shared|uploaded)\b/iu,
  /(?<author>我|[\p{L}\p{N}_-]{1,32})\s*在(?:哪裡|哪里|哪儿)\s*(?:分享|發|发|貼|贴|傳|传|上傳|上传)(?:過|过)?\s*(?<subject>.+?)(?:的)?[？?。！!]*$/u,
];

const SEARCH_MEDIA_TYPES: Array<{
  pattern: RegExp;
  has: NonNullable<MessageSearchPlan["has"]>;
}> = [
  { pattern: /\b(?:meme|image|photo|pic|picture|gif)\b/iu, has: "image" },
  { pattern: /\b(?:video|clip)\b/iu, has: "video" },
  { pattern: /\b(?:file|attachment|document)\b/iu, has: "file" },
  { pattern: /\bsticker\b/iu, has: "sticker" },
  { pattern: /\blink\b/iu, has: "link" },
];

const GENERIC_SEARCH_WORDS =
  /(?:\b(?:the|a|an|message|meme|image|photo|pic|picture|gif|video|clip|file|attachment|document|sticker|link)\b|那個|那个|這個|这个|的)/giu;

const SELF_AUTHOR_PATTERN = /^(?:i|me|myself|我|自己)$/iu;

export function parseMessageSearchRequest(
  request: string,
): MessageSearchPlan | null {
  const match = SEARCH_PATTERNS.map((pattern) => request.match(pattern)).find(
    Boolean,
  );
  const authorQuery = match?.groups?.author?.trim();
  const subject = match?.groups?.subject?.trim();

  if (!authorQuery || !subject) return null;

  const has = SEARCH_MEDIA_TYPES.find(({ pattern }) =>
    pattern.test(subject),
  )?.has;
  const content = subject
    .replace(GENERIC_SEARCH_WORDS, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    authorQuery,
    content: content || undefined,
    has,
  };
}

function memberNames(member: DiscordGuildMember) {
  return [member.nick, member.user?.global_name, member.user?.username].filter(
    (name): name is string => Boolean(name),
  );
}

async function resolveGuildMemberId({
  guildId,
  authorQuery,
  discordRequest,
}: {
  guildId: string;
  authorQuery: string;
  discordRequest: DiscordRequest;
}) {
  const query = new URLSearchParams({ query: authorQuery, limit: "10" });
  const members = await discordRequest<DiscordGuildMember[]>(
    `/guilds/${guildId}/members/search?${query}`,
  );
  const normalizedQuery = authorQuery.toLocaleLowerCase();
  const exactMatches = members.filter((member) =>
    memberNames(member).some(
      (name) => name.toLocaleLowerCase() === normalizedQuery,
    ),
  );
  const match =
    exactMatches.length === 1
      ? exactMatches[0]
      : members.length === 1
        ? members[0]
        : undefined;

  return match?.user?.id;
}

function toSearchResult(
  message: DiscordMessage,
  guildId: string,
  channelNames: Map<string, string>,
): ChatbotMessage {
  return {
    ...toChatbotMessage(message),
    channelId: message.channel_id,
    channelName: channelNames.get(message.channel_id),
    jumpUrl: `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`,
  };
}

export async function searchGuildMessages({
  guildId,
  requesterUserId,
  plan,
  discordRequest,
}: {
  guildId: string;
  requesterUserId: string;
  plan: MessageSearchPlan;
  discordRequest: DiscordRequest;
}) {
  const authorId = SELF_AUTHOR_PATTERN.test(plan.authorQuery)
    ? requesterUserId
    : await resolveGuildMemberId({
        guildId,
        authorQuery: plan.authorQuery,
        discordRequest,
      });
  if (!authorId) return [];

  const query = new URLSearchParams({
    limit: String(SEARCH_RESULT_LIMIT),
    author_type: "user",
    sort_by: plan.content ? "relevance" : "timestamp",
  });

  if (authorId) query.append("author_id", authorId);
  if (plan.content) query.set("content", plan.content);
  if (plan.has) query.append("has", plan.has);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await discordRequest<DiscordMessageSearchResponse>(
      `/guilds/${guildId}/messages/search?${query}`,
    );

    if (response.messages) {
      const channels = await discordRequest<DiscordChannel[]>(
        `/guilds/${guildId}/channels`,
      );
      const channelNames = new Map(
        channels.flatMap((channel) =>
          channel.name ? [[channel.id, channel.name] as const] : [],
        ),
      );
      const seen = new Set<string>();
      return response.messages
        .flat()
        .filter((message) => {
          if (seen.has(message.id)) return false;
          seen.add(message.id);
          return !message.webhook_id && !message.author?.bot;
        })
        .slice(0, SEARCH_RESULT_LIMIT)
        .map((message) => toSearchResult(message, guildId, channelNames));
    }

    if (response.code !== 110000 || attempt === 2) break;
    await Bun.sleep(Math.max(response.retry_after ?? 1, 1) * 1_000);
  }

  return [];
}

export async function getRecentHumanMessages({
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

  for (;;) {
    const query = new URLSearchParams({ limit: String(MESSAGE_PAGE_LIMIT) });
    if (before) {
      query.set("before", before);
    }

    const page = await discordRequest<DiscordMessage[]>(
      `/channels/${channelId}/messages?${query}`,
    );

    for (const message of page) {
      const withinHistoryWindow = new Date(message.timestamp) >= cutoff;
      const needsBackfill = messages.length < MESSAGE_LIMIT;

      if (
        isHumanContextMessage(message, requestMessageId) &&
        (withinHistoryWindow || needsBackfill)
      ) {
        messages.push(toChatbotMessage(message));
      }

      if (messages.length >= MESSAGE_LIMIT) {
        return messages.slice(0, MESSAGE_LIMIT).reverse();
      }
    }

    const oldestMessage = page.at(-1);
    if (page.length < MESSAGE_PAGE_LIMIT || !oldestMessage) {
      break;
    }

    if (oldestMessage.id === before) break;

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

  const requesterUserId = message.author.id;
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
      const searchPlan = message.guild_id
        ? parseMessageSearchRequest(request)
        : null;
      const searchPromise =
        message.guild_id && searchPlan
          ? searchGuildMessages({
              guildId: message.guild_id,
              requesterUserId,
              plan: searchPlan,
              discordRequest,
            })
              .then((results) => ({
                status: "complete" as const,
                results,
              }))
              .catch(() => {
                console.warn("Discord message search unavailable.");
                return {
                  status: "unavailable" as const,
                  results: [] as ChatbotMessage[],
                };
              })
          : Promise.resolve({
              status: "not_requested" as const,
              results: [] as ChatbotMessage[],
            });
      const [messages, search] = await Promise.all([
        getRecentHumanMessages({
          channelId: message.channel_id,
          requestMessageId: message.id,
          discordRequest,
        }),
        searchPromise,
      ]);
      const job: ChatbotJob = {
        id: randomUUID(),
        channelId: message.channel_id,
        requestMessageId: message.id,
        request,
        messages,
        searchStatus: search.status,
        searchResults: search.results,
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
