import { randomUUID } from "node:crypto";

import { macAgentBridge, type MacAgentJobResult } from "../chatbot/bridge";
import type {
  ChatbotAttachment,
  ChatbotIdentityCandidate,
  ChatbotIdentityResolution,
  ChatbotJob,
  ChatbotMessage,
  ChatbotSearchPurpose,
  ChatbotTask,
} from "../chatbot/protocol";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const AUTHORIZED_USER_ID = "917446775873343600";
const AUTHORIZED_GUILD_IDS = new Set([
  "917436845187563610",
  "1282936453134815275",
]);
const LOCAL_CONTEXT_LIMIT = 20;
const LOCAL_CONTEXT_FETCH_LIMIT = 25;
const MEDIUM_CONTEXT_LIMIT = 50;
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
  member?: {
    nick?: string | null;
    roles?: string[];
  };
  attachments?: DiscordAttachment[];
  embeds?: Array<{
    title?: string;
    description?: string;
    url?: string;
  }>;
  sticker_items?: Array<{ name?: string }>;
  reactions?: Array<{
    count: number;
    me?: boolean;
    emoji: {
      id?: string | null;
      name?: string | null;
      animated?: boolean;
    };
  }>;
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
  type?: number;
  permission_overwrites?: Array<{
    id: string;
    type: number;
    allow: string;
    deny: string;
  }>;
};

type DiscordRole = {
  id: string;
  permissions: string;
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
  purpose?: ChatbotSearchPurpose;
  author?: string;
  mentions?: string;
  content?: string;
  has?: SearchHas[];
  embedType?: SearchEmbedType;
  linkHostname?: string;
  attachmentExtension?: string;
  sortBy?: "relevance" | "timestamp";
  sortOrder?: "asc" | "desc";
};

export type DiscordContextPlan = {
  task: ChatbotTask;
  subject?: string;
  history: "local" | "medium" | "extended";
  queries: DiscordSearchQuery[];
};

export type IdentityResolution = ChatbotIdentityResolution;

type DiscordRequest = <T>(
  path: string,
  options?: { method?: string; body?: unknown },
) => Promise<T>;

export type ChatbotMention = DiscordMessage;

function authorAliases(message: DiscordMessage) {
  return [
    message.member?.nick,
    message.author?.global_name,
    message.author?.username,
  ].filter(
    (name, index, names): name is string =>
      Boolean(name) &&
      names.findIndex(
        (candidate) =>
          candidate?.toLocaleLowerCase() === name?.toLocaleLowerCase(),
      ) === index,
  );
}

function authorName(message: DiscordMessage) {
  return authorAliases(message)[0] || message.author?.id || "Unknown user";
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

function messageReactions(message: DiscordMessage) {
  return (message.reactions ?? []).flatMap((reaction) => {
    const name = reaction.emoji.name;
    if (!name) return [];

    return [
      {
        emoji: reaction.emoji.id
          ? `<${reaction.emoji.animated ? "a" : ""}:${name}:${reaction.emoji.id}>`
          : name,
        count: reaction.count,
        ...(reaction.me ? { me: true } : {}),
      },
    ];
  });
}

function contextMessage(
  message: DiscordMessage,
  botUserId?: string,
): Omit<ChatbotMessage, "referencedMessage"> {
  const aliases = authorAliases(message);

  return {
    id: message.id,
    role: message.author?.id === botUserId ? "assistant" : "user",
    author: authorName(message),
    ...(aliases.length > 1 ? { authorAliases: aliases } : {}),
    timestamp: message.timestamp,
    content: messageContent(message),
    attachments: (message.attachments ?? []).map(attachment),
    ...(message.reactions?.length
      ? { reactions: messageReactions(message) }
      : {}),
  };
}

export function toChatbotMessage(
  message: DiscordMessage,
  botUserId?: string,
): ChatbotMessage {
  return {
    ...contextMessage(message, botUserId),
    referencedMessage: message.referenced_message
      ? contextMessage(message.referenced_message, botUserId)
      : undefined,
  };
}

export function isConversationContextMessage(
  message: DiscordMessage,
  requestMessageId: string,
  botUserId: string,
) {
  return (
    message.id !== requestMessageId &&
    !message.webhook_id &&
    (!message.author?.bot || message.author?.id === botUserId)
  );
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

export function extractChatbotRequest(
  message: ChatbotMention,
  botUserId: string,
) {
  const content = message.content ?? "";
  const mentionRequest = extractMentionRequest(content, botUserId);

  if (mentionRequest !== null) {
    return mentionRequest;
  }

  return message.referenced_message?.author?.id === botUserId
    ? content.trim()
    : null;
}

export function isChatbotAuthorized(userId: string, guildId?: string) {
  return (
    userId === AUTHORIZED_USER_ID ||
    (guildId !== undefined && AUTHORIZED_GUILD_IDS.has(guildId))
  );
}

const PROTECTED_CHAT_SEGMENT =
  /```[\s\S]*?```|`[^`\n]*`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s，。！？；：]+/gu;

function normalizeChineseProse(content: string) {
  return content
    .replace(/[，、：；]/gu, " ")
    .replace(/[。！](?=\n)/gu, "")
    .replace(/[。！]/gu, "\n")
    .replace(/[「」『』]/gu, "")
    .replace(/[ \t]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{2,}/gu, "\n");
}

export function formatDiscordAnswer(content: string) {
  const trimmed = content.trim();
  let normalized = "";
  let previousEnd = 0;

  for (const match of trimmed.matchAll(PROTECTED_CHAT_SEGMENT)) {
    const start = match.index;
    normalized += normalizeChineseProse(trimmed.slice(previousEnd, start));
    normalized += match[0];
    previousEnd = start + match[0].length;
  }
  normalized += normalizeChineseProse(trimmed.slice(previousEnd));
  normalized = normalized.trim();

  if (!normalized) {
    return "我剛剛腦袋一片空白 再問我一次";
  }

  if (normalized.length <= DISCORD_MESSAGE_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, DISCORD_MESSAGE_LIMIT - 1).trimEnd()}…`;
}

const SELF_AUTHOR_PATTERN = /^(?:self|i|me|myself|我|自己)$/iu;
const USER_MENTION_PATTERN = /^<@!?(\d+)>$/u;
const SEARCH_PURPOSES = new Set<ChatbotSearchPurpose>([
  "context",
  "direct_mention",
  "self_claim",
  "candidate_check",
]);
const IDENTITY_BASES = new Set<IdentityResolution["basis"]>([
  "direct_self_link",
  "discord_member_profile",
  "independent_corroboration",
  "third_party_only",
  "conflicting",
  "none",
]);

function shortString(value: unknown, maximumLength: number) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximumLength)
    : undefined;
}

export function parseDiscordContextPlan(content: string): DiscordContextPlan {
  try {
    const normalized = content
      .trim()
      .replace(/^```(?:json)?\s*/iu, "")
      .replace(/\s*```$/u, "");
    const payload = JSON.parse(normalized) as {
      task?: unknown;
      subject?: unknown;
      history?: unknown;
      queries?: unknown;
    };
    const task =
      payload.task === "identity_resolution"
        ? "identity_resolution"
        : "general";
    const subject = shortString(payload.subject, 128);
    const history = ["medium", "extended"].includes(payload.history as string)
      ? (payload.history as "medium" | "extended")
      : "local";
    if (!Array.isArray(payload.queries)) {
      return { task, ...(subject ? { subject } : {}), history, queries: [] };
    }

    const queries = payload.queries.slice(0, 4).flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const query = value as Record<string, unknown>;
      const purpose = SEARCH_PURPOSES.has(query.purpose as ChatbotSearchPurpose)
        ? (query.purpose as ChatbotSearchPurpose)
        : undefined;
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
          ...(purpose ? { purpose } : {}),
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

    return { task, ...(subject ? { subject } : {}), history, queries };
  } catch {
    return { task: "general", history: "local", queries: [] };
  }
}

export function inferIdentitySubject(request: string) {
  const chinese = request.match(
    /^\s*(?:重新挑戰\s*)?(.{1,64}?)\s*(?:是誰|是哪位)[？?]?\s*$/u,
  );
  if (chinese?.[1]?.trim()) return chinese[1].trim();

  const english = request.match(/^\s*who(?:'s| is)\s+(.{1,64}?)[?]?\s*$/iu);
  return english?.[1]?.trim() || undefined;
}

export function identitySearchQueries(plan: DiscordContextPlan) {
  if (plan.task !== "identity_resolution" || !plan.subject) {
    return plan.queries;
  }

  return [
    {
      purpose: "candidate_check" as const,
      author: plan.subject,
      sortBy: "timestamp" as const,
      sortOrder: "desc" as const,
    },
    {
      purpose: "direct_mention" as const,
      mentions: plan.subject,
      sortBy: "timestamp" as const,
      sortOrder: "desc" as const,
    },
    ...plan.queries,
  ].slice(0, 4);
}

export function identitySubjectName(
  subject: string,
  member?: DiscordGuildMember,
) {
  return USER_MENTION_PATTERN.test(subject)
    ? (member && memberNames(member)[0]) || subject
    : subject;
}

export function isTraceExplanationRequest(request: string) {
  const normalized = request.trim().toLocaleLowerCase();
  return [
    /(?:how|why) did (?:you|she|sago|minisago) (?:decide|answer|respond|choose|reach|come up)/u,
    /(?:explain|show|tell me) (?:your|her|sago(?:'s)?) (?:decision|reasoning|trace|process)/u,
    /(?:你|妳|她|sago|小莎).{0,8}(?:怎麼|為什麼).{0,8}(?:決定|回答|判斷|得出|選)/u,
    /(?:怎麼|為什麼).{0,8}(?:這樣回答|這樣判斷|做這個決定)/u,
    /(?:決策|判斷|回答).{0,4}(?:過程|紀錄|軌跡)/u,
  ].some((pattern) => pattern.test(normalized));
}

export function parseIdentityResolution(
  content: string,
  subject: string,
  resultCount: number,
  identityCandidates: ChatbotIdentityCandidate[] = [],
): IdentityResolution {
  const fallback: IdentityResolution = {
    subject,
    confidence: "unknown",
    basis: "none",
    sourceIndexes: [],
  };

  try {
    const payload = JSON.parse(
      content
        .trim()
        .replace(/^```(?:json)?\s*/iu, "")
        .replace(/\s*```$/u, ""),
    ) as Record<string, unknown>;
    let basis = IDENTITY_BASES.has(payload.basis as IdentityResolution["basis"])
      ? (payload.basis as IdentityResolution["basis"])
      : "none";
    const candidate = shortString(payload.candidate, 64);
    const sourceIndexes = Array.isArray(payload.sourceIndexes)
      ? [
          ...new Set(
            payload.sourceIndexes.filter(
              (index): index is number =>
                Number.isInteger(index) && index >= 0 && index < resultCount,
            ),
          ),
        ].slice(0, 5)
      : [];
    let confidence: IdentityResolution["confidence"] = [
      "strong",
      "moderate",
      "weak",
      "unknown",
    ].includes(payload.confidence as string)
      ? (payload.confidence as IdentityResolution["confidence"])
      : "unknown";

    if (basis === "third_party_only") confidence = "weak";
    if (basis === "discord_member_profile") {
      const normalizedSubject = subject.toLocaleLowerCase();
      const normalizedCandidate = candidate?.toLocaleLowerCase();
      const hasProfileLink = identityCandidates.some((identityCandidate) => {
        const names = identityCandidate.names.map((name) =>
          name.toLocaleLowerCase(),
        );
        return (
          names.includes(normalizedSubject) &&
          Boolean(normalizedCandidate && names.includes(normalizedCandidate))
        );
      });
      if (!hasProfileLink) {
        basis = "none";
        confidence = "unknown";
      }
    }
    if (basis === "independent_corroboration" && confidence === "strong") {
      confidence = "moderate";
    }
    if (basis === "conflicting" || basis === "none") confidence = "unknown";

    return {
      subject,
      ...(candidate && basis !== "conflicting" && basis !== "none"
        ? { candidate }
        : {}),
      confidence,
      basis,
      sourceIndexes,
    };
  } catch {
    return fallback;
  }
}

function memberNames(member: DiscordGuildMember) {
  return [member.nick, member.user?.global_name, member.user?.username].filter(
    (name, index, names): name is string =>
      Boolean(name) &&
      names.findIndex(
        (candidate) =>
          candidate?.toLocaleLowerCase() === name?.toLocaleLowerCase(),
      ) === index,
  );
}

async function resolveGuildMember({
  guildId,
  memberQuery,
  discordRequest,
}: {
  guildId: string;
  memberQuery: string;
  discordRequest: DiscordRequest;
}) {
  const mentionedUserId = memberQuery.match(USER_MENTION_PATTERN)?.[1];
  if (mentionedUserId) {
    return discordRequest<DiscordGuildMember>(
      `/guilds/${guildId}/members/${mentionedUserId}`,
    );
  }

  const query = new URLSearchParams({ query: memberQuery, limit: "10" });
  const members = await discordRequest<DiscordGuildMember[]>(
    `/guilds/${guildId}/members/search?${query}`,
  );
  const normalizedQuery = memberQuery.toLocaleLowerCase();
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

  return match;
}

const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const SEARCHABLE_CHANNEL_TYPES = new Set([0, 5, 15, 16]);

export function canMemberSearchChannel({
  guildId,
  userId,
  roleIds,
  roles,
  channel,
}: {
  guildId: string;
  userId: string;
  roleIds: string[];
  roles: DiscordRole[];
  channel: DiscordChannel;
}) {
  const memberRoleIds = new Set([guildId, ...roleIds]);
  let permissions = roles.reduce(
    (value, role) =>
      memberRoleIds.has(role.id) ? value | BigInt(role.permissions) : value,
    0n,
  );

  if ((permissions & ADMINISTRATOR) === ADMINISTRATOR) return true;

  const overwrites = channel.permission_overwrites ?? [];
  const applyOverwrite = (deny: bigint, allow: bigint) => {
    permissions = (permissions & ~deny) | allow;
  };
  const everyone = overwrites.find(
    (overwrite) => overwrite.type === 0 && overwrite.id === guildId,
  );
  if (everyone) applyOverwrite(BigInt(everyone.deny), BigInt(everyone.allow));

  let roleDeny = 0n;
  let roleAllow = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type === 0 && roleIds.includes(overwrite.id)) {
      roleDeny |= BigInt(overwrite.deny);
      roleAllow |= BigInt(overwrite.allow);
    }
  }
  applyOverwrite(roleDeny, roleAllow);

  const member = overwrites.find(
    (overwrite) => overwrite.type === 1 && overwrite.id === userId,
  );
  if (member) applyOverwrite(BigInt(member.deny), BigInt(member.allow));

  return (
    (permissions & VIEW_CHANNEL) === VIEW_CHANNEL &&
    (permissions & READ_MESSAGE_HISTORY) === READ_MESSAGE_HISTORY
  );
}

async function requesterSearchChannels({
  guildId,
  requesterUserId,
  requesterRoleIds,
  currentChannelId,
  discordRequest,
}: {
  guildId: string;
  requesterUserId: string;
  requesterRoleIds?: string[];
  currentChannelId: string;
  discordRequest: DiscordRequest;
}) {
  if (!requesterRoleIds) {
    return { ids: [currentChannelId], names: new Map<string, string>() };
  }

  try {
    const [roles, channels] = await Promise.all([
      discordRequest<DiscordRole[]>(`/guilds/${guildId}/roles`),
      discordRequest<DiscordChannel[]>(`/guilds/${guildId}/channels`),
    ]);
    const visible = channels.filter(
      (channel) =>
        SEARCHABLE_CHANNEL_TYPES.has(channel.type ?? -1) &&
        canMemberSearchChannel({
          guildId,
          userId: requesterUserId,
          roleIds: requesterRoleIds,
          roles,
          channel,
        }),
    );
    const ids = [currentChannelId, ...visible.map((channel) => channel.id)]
      .filter((id, index, values) => values.indexOf(id) === index)
      .slice(0, 500);
    const names = new Map(
      visible.flatMap((channel) =>
        channel.name ? [[channel.id, channel.name] as const] : [],
      ),
    );
    return { ids, names };
  } catch {
    return { ids: [currentChannelId], names: new Map<string, string>() };
  }
}

function toSearchResult(
  message: DiscordMessage,
  guildId: string,
  channelNames: Map<string, string>,
  searchPurposes: ChatbotSearchPurpose[],
): ChatbotMessage {
  return {
    ...toChatbotMessage(message),
    channelId: message.channel_id,
    channelName: channelNames.get(message.channel_id),
    jumpUrl: `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`,
    ...(searchPurposes.length > 0 ? { searchPurposes } : {}),
  };
}

export async function searchGuildMessages({
  guildId,
  requesterUserId,
  requesterRoleIds,
  currentChannelId,
  requestMessageId,
  queries,
  knownMembers = [],
  discordRequest,
}: {
  guildId: string;
  requesterUserId: string;
  requesterRoleIds?: string[];
  currentChannelId: string;
  requestMessageId: string;
  queries: DiscordSearchQuery[];
  knownMembers?: DiscordGuildMember[];
  discordRequest: DiscordRequest;
}) {
  const searchableChannels = await requesterSearchChannels({
    guildId,
    requesterUserId,
    requesterRoleIds,
    currentChannelId,
    discordRequest,
  });
  const memberIds = new Map<string, string | undefined>();
  for (const member of knownMembers) {
    for (const name of memberNames(member)) {
      memberIds.set(name.toLocaleLowerCase(), member.user?.id);
    }
  }
  const matches = new Map<
    string,
    { message: DiscordMessage; purposes: Set<ChatbotSearchPurpose> }
  >();

  for (const search of queries.slice(0, 4)) {
    const resolveMemberId = async (memberQuery: string) => {
      const normalizedMember = memberQuery.toLocaleLowerCase();
      let memberId = SELF_AUTHOR_PATTERN.test(memberQuery)
        ? requesterUserId
        : memberIds.get(normalizedMember);
      if (!memberId && !memberIds.has(normalizedMember)) {
        const member = await resolveGuildMember({
          guildId,
          memberQuery,
          discordRequest,
        });
        memberId = member?.user?.id;
        memberIds.set(normalizedMember, memberId);
      }
      return memberId;
    };
    const authorId = search.author
      ? await resolveMemberId(search.author)
      : undefined;
    const mentionedId = search.mentions
      ? await resolveMemberId(search.mentions)
      : undefined;
    if ((search.author && !authorId) || (search.mentions && !mentionedId)) {
      continue;
    }

    const query = new URLSearchParams({
      limit: String(SEARCH_QUERY_LIMIT),
      author_type: "user",
      sort_by: search.sortBy ?? (search.content ? "relevance" : "timestamp"),
      sort_order: search.sortOrder ?? "desc",
    });
    if (authorId) query.append("author_id", authorId);
    if (mentionedId) query.append("mentions", mentionedId);
    if (search.content) query.set("content", search.content);
    for (const has of search.has ?? []) query.append("has", has);
    if (search.embedType) query.append("embed_type", search.embedType);
    if (search.linkHostname) query.append("link_hostname", search.linkHostname);
    if (search.attachmentExtension)
      query.append("attachment_extension", search.attachmentExtension);
    for (const channelId of searchableChannels.ids) {
      query.append("channel_id", channelId);
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await discordRequest<DiscordMessageSearchResponse>(
        `/guilds/${guildId}/messages/search?${query}`,
      );

      if (response.messages) {
        for (const message of response.messages.flat()) {
          if (
            message.id === requestMessageId ||
            message.webhook_id ||
            message.author?.bot
          ) {
            continue;
          }
          const existing = matches.get(message.id);
          if (existing) {
            if (search.purpose) existing.purposes.add(search.purpose);
            continue;
          }
          if (matches.size >= SEARCH_RESULT_LIMIT) continue;
          matches.set(message.id, {
            message,
            purposes: new Set(search.purpose ? [search.purpose] : []),
          });
        }
        break;
      }

      if (response.code !== 110000 || attempt === 2) break;
      await Bun.sleep(Math.max(response.retry_after ?? 1, 1) * 1_000);
    }

    if (matches.size >= SEARCH_RESULT_LIMIT) break;
  }

  if (matches.size === 0) return [];

  return [...matches.values()].map(({ message, purposes }) =>
    toSearchResult(message, guildId, searchableChannels.names, [...purposes]),
  );
}

export async function getNearbyHumanMessages({
  channelId,
  requestMessageId,
  botUserId,
  discordRequest,
}: {
  channelId: string;
  requestMessageId: string;
  botUserId: string;
  discordRequest: DiscordRequest;
}) {
  const query = new URLSearchParams({
    around: requestMessageId,
    limit: String(LOCAL_CONTEXT_FETCH_LIMIT),
  });
  const messages = await discordRequest<DiscordMessage[]>(
    `/channels/${channelId}/messages?${query}`,
  );

  return messages
    .filter((message) =>
      isConversationContextMessage(message, requestMessageId, botUserId),
    )
    .slice(0, LOCAL_CONTEXT_LIMIT)
    .map((message) => toChatbotMessage(message, botUserId))
    .reverse();
}

export async function getRecentHumanMessages({
  channelId,
  requestMessageId,
  botUserId,
  discordRequest,
  messageLimit = MESSAGE_LIMIT,
  now = new Date(),
}: {
  channelId: string;
  requestMessageId: string;
  botUserId: string;
  discordRequest: DiscordRequest;
  messageLimit?: number;
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
      const needsBackfill = messages.length < messageLimit;

      if (
        isConversationContextMessage(message, requestMessageId, botUserId) &&
        (withinHistoryWindow || needsBackfill)
      ) {
        messages.push(toChatbotMessage(message, botUserId));
      }

      if (messages.length >= messageLimit) {
        return messages.slice(0, messageLimit).reverse();
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

function channelMessageBody(content: string) {
  return {
    content,
    allowed_mentions: {
      parse: [],
    },
  };
}

async function postChatbotResponse(
  message: DiscordMessage,
  content: string,
  discordRequest: DiscordRequest,
) {
  let canPostDirectly = false;

  try {
    const latestMessages = await discordRequest<DiscordMessage[]>(
      `/channels/${message.channel_id}/messages?limit=1`,
    );
    canPostDirectly = latestMessages[0]?.id === message.id;
  } catch {
    // A reply keeps the relationship clear when the latest message is unknown.
  }

  await discordRequest(`/channels/${message.channel_id}/messages`, {
    method: "POST",
    body: canPostDirectly
      ? channelMessageBody(content)
      : replyBody(message, content),
  });
}

async function withTyping<T>(
  channelId: string,
  discordRequest: DiscordRequest,
  task: () => Promise<T>,
) {
  await discordRequest(`/channels/${channelId}/typing`, {
    method: "POST",
  }).catch(() => undefined);
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
  const requesterUserId = message.author?.id;

  if (!requesterUserId || message.author?.bot || message.webhook_id) {
    return false;
  }

  const request = extractChatbotRequest(message, botUserId);
  if (request === null) {
    return false;
  }

  if (!isChatbotAuthorized(requesterUserId, message.guild_id)) {
    if (!message.guild_id) {
      return false;
    }

    await postChatbotResponse(
      message,
      `在這個伺服器裡我暫時只聽 <@${AUTHORIZED_USER_ID}> 的 抱歉啦`,
      discordRequest,
    );
    return true;
  }

  const acquired = macAgentBridge.acquireWorkflow();

  if (acquired.status === "offline") {
    await postChatbotResponse(
      message,
      "叫曦打開他的 Mac 我才能動啦 💤",
      discordRequest,
    );
    return true;
  }

  if (acquired.status === "busy") {
    await postChatbotResponse(
      message,
      "我正在幫別人做事 等我一下下",
      discordRequest,
    );
    return true;
  }

  const { workflow } = acquired;
  let result: MacAgentJobResult;
  let searchUnavailable = false;
  try {
    result = await withTyping(message.channel_id, discordRequest, async () => {
      const requestMessage = toChatbotMessage(message, botUserId);
      if (isTraceExplanationRequest(request)) {
        const traceDispatch = workflow.dispatch({
          id: randomUUID(),
          purpose: "trace_explanation",
          channelId: message.channel_id,
          requestMessageId: message.id,
          request,
          requestMessage,
          messages: [],
        });

        if (traceDispatch.status !== "accepted") {
          return { ok: false as const, error: "The Mac disconnected." };
        }

        return traceDispatch.result;
      }

      let messages = message.guild_id
        ? await getNearbyHumanMessages({
            channelId: message.channel_id,
            requestMessageId: message.id,
            botUserId,
            discordRequest,
          })
        : await getRecentHumanMessages({
            channelId: message.channel_id,
            requestMessageId: message.id,
            botUserId,
            discordRequest,
          });
      let search: {
        status: "not_requested" | "complete" | "unavailable";
        results: ChatbotMessage[];
      } = { status: "not_requested", results: [] };
      let plan: DiscordContextPlan = {
        task: "general",
        history: "local",
        queries: [],
      };
      let identityMember: DiscordGuildMember | undefined;
      let identityCandidates: ChatbotIdentityCandidate[] = [];
      const inferredIdentitySubject = inferIdentitySubject(request);

      if (message.guild_id) {
        const plannerJob: ChatbotJob = {
          id: randomUUID(),
          purpose: "context_plan",
          channelId: message.channel_id,
          requestMessageId: message.id,
          request,
          requestMessage,
          messages,
        };
        const plannerDispatch = workflow.dispatch(plannerJob);

        if (plannerDispatch.status === "accepted") {
          const plannerResult = await plannerDispatch.result;
          if (!plannerResult.ok) {
            console.warn(
              `Discord context planning unavailable: ${plannerResult.error}`,
            );
          } else {
            plan = parseDiscordContextPlan(plannerResult.content);
          }
        } else {
          console.warn("Discord context planning unavailable.");
        }

        if (inferredIdentitySubject) {
          plan = {
            ...plan,
            task: "identity_resolution",
            subject: inferredIdentitySubject,
          };
        }

        if (plan.task === "identity_resolution" && plan.subject) {
          try {
            identityMember = await resolveGuildMember({
              guildId: message.guild_id,
              memberQuery: plan.subject,
              discordRequest,
            });
            const names = identityMember ? memberNames(identityMember) : [];
            if (names.length > 0) {
              identityCandidates = [{ names }];
              plan = {
                ...plan,
                subject: identitySubjectName(plan.subject, identityMember),
              };
            }
          } catch {
            console.warn("Discord member lookup unavailable.");
          }
        }

        const searchQueries = identitySearchQueries(plan);

        const historyLimit =
          plan.history === "extended"
            ? MESSAGE_LIMIT
            : plan.history === "medium"
              ? MEDIUM_CONTEXT_LIMIT
              : LOCAL_CONTEXT_LIMIT;
        const historyPromise =
          plan.history !== "local"
            ? getRecentHumanMessages({
                channelId: message.channel_id,
                requestMessageId: message.id,
                botUserId,
                discordRequest,
                messageLimit: historyLimit,
              })
            : Promise.resolve(messages);
        const searchPromise =
          searchQueries.length > 0
            ? searchGuildMessages({
                guildId: message.guild_id,
                requesterUserId,
                requesterRoleIds: message.member?.roles,
                currentChannelId: message.channel_id,
                requestMessageId: message.id,
                queries: searchQueries,
                knownMembers: identityMember ? [identityMember] : [],
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
            : Promise.resolve(search);

        [messages, search] = await Promise.all([historyPromise, searchPromise]);
        searchUnavailable = search.status === "unavailable";
      } else if (inferredIdentitySubject) {
        plan = {
          ...plan,
          task: "identity_resolution",
          subject: inferredIdentitySubject,
        };
      }

      if (plan.task === "identity_resolution" && plan.subject) {
        const evidenceJob: ChatbotJob = {
          id: randomUUID(),
          purpose: "identity_resolution",
          task: plan.task,
          subject: plan.subject,
          channelId: message.channel_id,
          requestMessageId: message.id,
          request,
          requestMessage,
          identityCandidates,
          messages,
          searchStatus: search.status,
          searchResults: search.results,
        };
        const evidenceDispatch = workflow.dispatch(evidenceJob);

        if (evidenceDispatch.status === "offline") {
          return { ok: false as const, error: "The Mac disconnected." };
        }

        if (evidenceDispatch.status === "busy") {
          return { ok: false as const, error: "The Mac became busy." };
        }

        const evidenceResult = await evidenceDispatch.result;
        const resolution = evidenceResult.ok
          ? parseIdentityResolution(
              evidenceResult.content,
              plan.subject,
              search.results.length,
              identityCandidates,
            )
          : parseIdentityResolution(
              "",
              plan.subject,
              search.results.length,
              identityCandidates,
            );

        const answerJob: ChatbotJob = {
          ...evidenceJob,
          id: randomUUID(),
          purpose: "answer",
          identityResolution: resolution,
        };
        const answerDispatch = workflow.dispatch(answerJob);

        if (answerDispatch.status === "offline") {
          return { ok: false as const, error: "The Mac disconnected." };
        }

        if (answerDispatch.status === "busy") {
          return { ok: false as const, error: "The Mac became busy." };
        }

        return answerDispatch.result;
      }

      const job: ChatbotJob = {
        id: randomUUID(),
        purpose: "answer",
        channelId: message.channel_id,
        requestMessageId: message.id,
        request,
        requestMessage,
        messages,
        searchStatus: search.status,
        searchResults: search.results,
      };
      const dispatch = workflow.dispatch(job);

      if (dispatch.status === "offline") {
        return { ok: false as const, error: "The Mac disconnected." };
      }

      if (dispatch.status === "busy") {
        return { ok: false as const, error: "The Mac became busy." };
      }

      return dispatch.result;
    });
  } catch (error) {
    console.error(`Chatbot request ${message.id} failed:`, error);
    result = { ok: false, error: "聊天機器人請求失敗" };
  } finally {
    workflow.release();
  }
  const content = result.ok
    ? formatDiscordAnswer(
        searchUnavailable
          ? `我剛剛翻不到伺服器的舊訊息 這次回答可能不太完整\n\n${result.content}`
          : result.content,
      )
    : "我剛剛卡住了 晚點再叫我一次";

  await postChatbotResponse(message, content, discordRequest);

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
