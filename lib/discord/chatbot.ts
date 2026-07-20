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
const SEARCH_QUERY_LIMIT = 10;
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

const SEARCH_HAS_VALUES = [
  "image",
  "sound",
  "video",
  "file",
  "sticker",
  "embed",
  "link",
  "poll",
  "snapshot",
] as const;
const SEARCH_EMBED_TYPES = [
  "image",
  "video",
  "gif",
  "sound",
  "article",
] as const;

type SearchHas = (typeof SEARCH_HAS_VALUES)[number];
type SearchEmbedType = (typeof SEARCH_EMBED_TYPES)[number];

export type DiscordSearchQuery = {
  author?: string;
  content?: string;
  has?: SearchHas[];
  embedType?: SearchEmbedType;
  linkHostname?: string;
  attachmentExtension?: string;
  sortBy?: "relevance" | "timestamp";
  sortOrder?: "asc" | "desc";
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

const SELF_AUTHOR_PATTERN = /^(?:self|i|me|myself|我|自己)$/iu;
const MESSAGE_SEARCH_HINT =
  /(?:\b(?:when|where|find|search|repost|resend|sent|posted|shared|uploaded)\b|哪裡|哪里|哪儿|何時|何时|什麼時候|什么时候|找|搜尋|搜索|分享|發過|发过|貼過|贴过|傳過|传过)/iu;

export function shouldPlanDiscordSearch(request: string) {
  return MESSAGE_SEARCH_HINT.test(request);
}

function shortString(value: unknown, maximumLength: number) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximumLength)
    : undefined;
}

export function parseDiscordSearchPlan(content: string): DiscordSearchQuery[] {
  try {
    const normalized = content
      .trim()
      .replace(/^```(?:json)?\s*/iu, "")
      .replace(/\s*```$/u, "");
    const payload = JSON.parse(normalized) as { queries?: unknown };
    if (!Array.isArray(payload.queries)) return [];

    return payload.queries.slice(0, 4).flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const query = value as Record<string, unknown>;
      const author = shortString(query.author, 64);
      const searchContent = shortString(query.content, 1_024);
      const has = Array.isArray(query.has)
        ? [
            ...new Set(
              query.has.filter((item): item is SearchHas =>
                SEARCH_HAS_VALUES.includes(item as SearchHas),
              ),
            ),
          ].slice(0, 4)
        : undefined;
      const embedType = SEARCH_EMBED_TYPES.includes(
        query.embedType as SearchEmbedType,
      )
        ? (query.embedType as SearchEmbedType)
        : undefined;
      const linkHostname = shortString(query.linkHostname, 256);
      const attachmentExtension = shortString(
        query.attachmentExtension,
        32,
      )?.replace(/^\./, "");
      const sortBy = ["relevance", "timestamp"].includes(query.sortBy as string)
        ? (query.sortBy as DiscordSearchQuery["sortBy"])
        : undefined;
      const sortOrder = ["asc", "desc"].includes(query.sortOrder as string)
        ? (query.sortOrder as DiscordSearchQuery["sortOrder"])
        : undefined;

      if (
        !author &&
        !searchContent &&
        !has?.length &&
        !embedType &&
        !linkHostname &&
        !attachmentExtension
      ) {
        return [];
      }

      return [
        {
          ...(author ? { author } : {}),
          ...(searchContent ? { content: searchContent } : {}),
          ...(has?.length ? { has } : {}),
          ...(embedType ? { embedType } : {}),
          ...(linkHostname ? { linkHostname } : {}),
          ...(attachmentExtension ? { attachmentExtension } : {}),
          ...(sortBy ? { sortBy } : {}),
          ...(sortOrder ? { sortOrder } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
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
  requestMessageId,
  queries,
  discordRequest,
}: {
  guildId: string;
  requesterUserId: string;
  requestMessageId: string;
  queries: DiscordSearchQuery[];
  discordRequest: DiscordRequest;
}) {
  const memberIds = new Map<string, string | undefined>();
  const matches: DiscordMessage[] = [];
  const seenMessages = new Set<string>();

  for (const search of queries.slice(0, 4)) {
    let authorId: string | undefined;
    if (search.author) {
      const normalizedAuthor = search.author.toLocaleLowerCase();
      authorId = SELF_AUTHOR_PATTERN.test(search.author)
        ? requesterUserId
        : memberIds.get(normalizedAuthor);
      if (!authorId && !memberIds.has(normalizedAuthor)) {
        authorId = await resolveGuildMemberId({
          guildId,
          authorQuery: search.author,
          discordRequest,
        });
        memberIds.set(normalizedAuthor, authorId);
      }
      if (!authorId) continue;
    }

    const query = new URLSearchParams({
      limit: String(SEARCH_QUERY_LIMIT),
      author_type: "user",
      sort_by: search.sortBy ?? (search.content ? "relevance" : "timestamp"),
      sort_order: search.sortOrder ?? "desc",
    });
    if (authorId) query.append("author_id", authorId);
    if (search.content) query.set("content", search.content);
    for (const has of search.has ?? []) query.append("has", has);
    if (search.embedType) query.append("embed_type", search.embedType);
    if (search.linkHostname) query.append("link_hostname", search.linkHostname);
    if (search.attachmentExtension)
      query.append("attachment_extension", search.attachmentExtension);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await discordRequest<DiscordMessageSearchResponse>(
        `/guilds/${guildId}/messages/search?${query}`,
      );

      if (response.messages) {
        for (const message of response.messages.flat()) {
          if (
            matches.length >= SEARCH_RESULT_LIMIT ||
            message.id === requestMessageId ||
            seenMessages.has(message.id) ||
            message.webhook_id ||
            message.author?.bot
          ) {
            continue;
          }
          seenMessages.add(message.id);
          matches.push(message);
        }
        break;
      }

      if (response.code !== 110000 || attempt === 2) break;
      await Bun.sleep(Math.max(response.retry_after ?? 1, 1) * 1_000);
    }

    if (matches.length >= SEARCH_RESULT_LIMIT) break;
  }

  if (matches.length === 0) return [];

  const channels = await discordRequest<DiscordChannel[]>(
    `/guilds/${guildId}/channels`,
  );
  const channelNames = new Map(
    channels.flatMap((channel) =>
      channel.name ? [[channel.id, channel.name] as const] : [],
    ),
  );

  return matches.map((message) =>
    toSearchResult(message, guildId, channelNames),
  );
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
      const messages = await getRecentHumanMessages({
        channelId: message.channel_id,
        requestMessageId: message.id,
        discordRequest,
      });
      let search: {
        status: "not_requested" | "complete" | "unavailable";
        results: ChatbotMessage[];
      } = { status: "not_requested", results: [] };

      if (message.guild_id && shouldPlanDiscordSearch(request)) {
        const plannerJob: ChatbotJob = {
          id: randomUUID(),
          purpose: "search_plan",
          channelId: message.channel_id,
          requestMessageId: message.id,
          request,
          messages,
        };
        const plannerDispatch = macAgentBridge.dispatch(plannerJob);

        if (plannerDispatch.status !== "accepted") {
          search = { status: "unavailable", results: [] };
        } else {
          const plannerResult = await plannerDispatch.result;
          if (!plannerResult.ok) {
            search = { status: "unavailable", results: [] };
          } else {
            const queries = parseDiscordSearchPlan(plannerResult.content);
            if (queries.length > 0) {
              search = await searchGuildMessages({
                guildId: message.guild_id,
                requesterUserId,
                requestMessageId: message.id,
                queries,
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
                });
            }
          }
        }
      }

      const job: ChatbotJob = {
        id: randomUUID(),
        purpose: "answer",
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
