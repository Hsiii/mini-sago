import { randomUUID } from "node:crypto";

import { OWNER_DISCORD_USER_ID } from "../chatbot/access";
import { macAgentBridge, type MacAgentJobResult } from "../chatbot/bridge";
import { CHATBOT_CONTEXT_LIMITS } from "../chatbot/context-limits";
import type {
  ChatbotAttachment,
  ChatbotExecutionMode,
  ChatbotExecutionTarget,
  ChatbotMutationScope,
  ChatbotJob,
  ChatbotMemberResult,
  ChatbotMessage,
  ChatbotTraceContext,
} from "../chatbot/protocol";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const AUTHORIZED_GUILD_IDS = new Set([
  "917436845187563610",
  "1282936453134815275",
  "1439286996869713992",
  "1521168712579682567",
]);
const AUTHORIZED_CHANNEL_IDS = new Set(["1517766866964316201"]);
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
  historyCount: number;
  includePreviousTrace: boolean;
  memberQueries: string[];
  queries: DiscordSearchQuery[];
};

type DiscordRequest = <T>(
  path: string,
  options?: { method?: string; body?: unknown },
) => Promise<T>;

export type ApprovedMutation = {
  requestMessageId: string;
  mode: "dev";
  target: ChatbotExecutionTarget;
  mutationScope: ChatbotMutationScope;
  repository: string;
};

type PendingMutation = {
  message: ChatbotMention;
  botUserId: string;
  approval: ApprovedMutation;
  expiresAt: number;
};

const MUTATION_APPROVAL_PREFIX = "minisago:mutation:";
const MUTATION_APPROVAL_TTL_MS = 10 * 60_000;
const MAX_PENDING_MUTATIONS = 100;
const pendingMutations = new Map<string, PendingMutation>();

export type ChatbotMention = DiscordMessage;

function prunePendingMutations(now = Date.now()) {
  for (const [id, pending] of pendingMutations) {
    if (pending.expiresAt <= now) pendingMutations.delete(id);
  }
  while (pendingMutations.size >= MAX_PENDING_MUTATIONS) {
    const oldest = pendingMutations.keys().next().value;
    if (!oldest) break;
    pendingMutations.delete(oldest);
  }
}

function mutationApprovalContent(approval: ApprovedMutation) {
  const action = {
    code: "修改程式碼並建立草稿 PR",
    issue: "修改 GitHub issue",
    deploy: "執行部署工作",
  }[approval.mutationScope];
  return `我理解成要在 \`${approval.repository}\` ${action}\n按下面的按鈕才會真的給這次工作寫入權限`;
}

export function registerMutationApproval(
  message: ChatbotMention,
  botUserId: string,
  approval: ApprovedMutation,
) {
  prunePendingMutations();
  const id = randomUUID();
  pendingMutations.set(id, {
    message,
    botUserId,
    approval,
    expiresAt: Date.now() + MUTATION_APPROVAL_TTL_MS,
  });
  return `${MUTATION_APPROVAL_PREFIX}${id}`;
}

export function takeChatbotMutationApproval({
  customId,
  userId,
  discordRequest,
}: {
  customId?: string;
  userId?: string;
  discordRequest: DiscordRequest;
}):
  | null
  | { status: "forbidden" | "expired" }
  | { status: "accepted"; content: string; run: () => Promise<boolean> } {
  if (!customId?.startsWith(MUTATION_APPROVAL_PREFIX)) return null;
  const id = customId.slice(MUTATION_APPROVAL_PREFIX.length);
  const pending = pendingMutations.get(id);
  if (userId !== OWNER_DISCORD_USER_ID) return { status: "forbidden" };
  if (!pending || pending.expiresAt <= Date.now()) {
    if (pending) pendingMutations.delete(id);
    return { status: "expired" };
  }

  pendingMutations.delete(id);
  return {
    status: "accepted",
    content: `已允許這次在 \`${pending.approval.repository}\` 的 ${pending.approval.mutationScope} 工作`,
    run: () =>
      handleChatbotMention({
        message: pending.message,
        botUserId: pending.botUserId,
        discordRequest,
        approvedMutation: pending.approval,
      }),
  };
}

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

  if (!message.guild_id && message.author?.id === OWNER_DISCORD_USER_ID) {
    return content.trim();
  }

  return message.referenced_message?.author?.id === botUserId
    ? content.trim()
    : null;
}

export function isChatbotAuthorized(
  userId: string,
  guildId?: string,
  channelId?: string,
) {
  return (
    userId === OWNER_DISCORD_USER_ID ||
    (guildId !== undefined && AUTHORIZED_GUILD_IDS.has(guildId)) ||
    (channelId !== undefined && AUTHORIZED_CHANNEL_IDS.has(channelId))
  );
}

function normalizeDiscordAnswer(content: string) {
  const normalized = content.trim();

  if (!normalized) {
    return "我剛剛腦袋一片空白 再問我一次";
  }

  return normalized;
}

function limitDiscordMessage(content: string) {
  return content.length <= DISCORD_MESSAGE_LIMIT
    ? content
    : `${content.slice(0, DISCORD_MESSAGE_LIMIT - 1).trimEnd()}…`;
}

export function formatDiscordAnswer(content: string) {
  return limitDiscordMessage(normalizeDiscordAnswer(content));
}

export function formatDiscordAnswers(content: string) {
  return normalizeDiscordAnswer(content)
    .split(/\n{2,}/u)
    .map((part) => limitDiscordMessage(part.trim()))
    .filter(Boolean);
}

const SELF_AUTHOR_PATTERN = /^(?:self|i|me|myself|我|自己)$/iu;
const USER_MENTION_PATTERN = /^<@!?(\d+)>$/u;
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
      historyCount?: unknown;
      includePreviousTrace?: unknown;
      memberQueries?: unknown;
      queries?: unknown;
    };
    const historyCount =
      typeof payload.historyCount === "number" &&
      Number.isInteger(payload.historyCount)
        ? Math.min(
            Math.max(payload.historyCount, 0),
            CHATBOT_CONTEXT_LIMITS.maximumHistoryMessages,
          )
        : CHATBOT_CONTEXT_LIMITS.nearbyMessages;
    const memberQueries = Array.isArray(payload.memberQueries)
      ? [
          ...new Set(
            payload.memberQueries.flatMap((value) => {
              const query = shortString(
                value,
                CHATBOT_CONTEXT_LIMITS.maximumMemberQueryCharacters,
              );
              return query ? [query] : [];
            }),
          ),
        ].slice(0, CHATBOT_CONTEXT_LIMITS.maximumMemberLookups)
      : [];
    const includePreviousTrace = payload.includePreviousTrace === true;
    if (!Array.isArray(payload.queries)) {
      return {
        historyCount,
        includePreviousTrace,
        memberQueries,
        queries: [],
      };
    }

    const queries = payload.queries
      .slice(0, CHATBOT_CONTEXT_LIMITS.maximumSearchQueries)
      .flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const query = value as Record<string, unknown>;
        const author = shortString(
          query.author,
          CHATBOT_CONTEXT_LIMITS.maximumSearchAuthorCharacters,
        );
        const mentions = shortString(
          query.mentions,
          CHATBOT_CONTEXT_LIMITS.maximumSearchAuthorCharacters,
        );
        const searchContent = shortString(
          query.content,
          CHATBOT_CONTEXT_LIMITS.maximumSearchContentCharacters,
        );
        const has = Array.isArray(query.has)
          ? [
              ...new Set(
                query.has.filter((item): item is SearchHas =>
                  SEARCH_HAS_VALUES.includes(item as SearchHas),
                ),
              ),
            ].slice(0, CHATBOT_CONTEXT_LIMITS.maximumSearchFilters)
          : undefined;
        const embedType = SEARCH_EMBED_TYPES.includes(
          query.embedType as SearchEmbedType,
        )
          ? (query.embedType as SearchEmbedType)
          : undefined;
        const linkHostname = shortString(
          query.linkHostname,
          CHATBOT_CONTEXT_LIMITS.maximumSearchHostnameCharacters,
        );
        const attachmentExtension = shortString(
          query.attachmentExtension,
          CHATBOT_CONTEXT_LIMITS.maximumSearchExtensionCharacters,
        )?.replace(/^\./, "");
        const sortBy = ["relevance", "timestamp"].includes(
          query.sortBy as string,
        )
          ? (query.sortBy as DiscordSearchQuery["sortBy"])
          : undefined;
        const sortOrder = ["asc", "desc"].includes(query.sortOrder as string)
          ? (query.sortOrder as DiscordSearchQuery["sortOrder"])
          : undefined;

        if (
          !author &&
          !mentions &&
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
            ...(mentions ? { mentions } : {}),
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

    return { historyCount, includePreviousTrace, memberQueries, queries };
  } catch {
    return {
      historyCount: CHATBOT_CONTEXT_LIMITS.nearbyMessages,
      includePreviousTrace: false,
      memberQueries: [],
      queries: [],
    };
  }
}

export function parsePreviousTraceLookup(content: string): {
  status: "complete" | "not_found" | "unavailable";
  trace?: ChatbotTraceContext;
} {
  try {
    const payload = JSON.parse(content) as {
      status?: unknown;
      trace?: unknown;
    };
    if (payload.status === "not_found") return { status: "not_found" };
    if (
      payload.status !== "complete" ||
      !payload.trace ||
      typeof payload.trace !== "object"
    ) {
      return { status: "unavailable" };
    }
    const trace = payload.trace as Partial<ChatbotTraceContext>;
    if (
      typeof trace.contextMessageCount !== "number" ||
      typeof trace.searchResultCount !== "number" ||
      typeof trace.elapsedMs !== "number" ||
      !Array.isArray(trace.searchQueries) ||
      !Array.isArray(trace.memberQueries)
    ) {
      return { status: "unavailable" };
    }
    return {
      status: "complete",
      trace: trace as ChatbotTraceContext,
    };
  } catch {
    return { status: "unavailable" };
  }
}

export function parseExecutionRoute(
  content: string,
  availableRepositories: string[] = [],
): {
  mode: ChatbotExecutionMode;
  target: ChatbotExecutionTarget;
  mutationScope?: ChatbotMutationScope;
  repository?: string;
} {
  const advertisedRepositories = new Map(
    availableRepositories.map((repository) => [
      repository.toLocaleLowerCase("en-US"),
      repository,
    ]),
  );

  try {
    const normalized = content
      .trim()
      .replace(/^```(?:json)?\s*/iu, "")
      .replace(/\s*```$/u, "");
    const payload = JSON.parse(normalized) as {
      mode?: unknown;
      target?: unknown;
      repository?: unknown;
      mutationScope?: unknown;
    };
    if (payload.mode === "dev" || payload.mode === "chat") {
      const mutationScope = ["code", "issue", "deploy"].includes(
        payload.mutationScope as string,
      )
        ? (payload.mutationScope as ChatbotMutationScope)
        : undefined;
      const mode = mutationScope ? "dev" : payload.mode;
      const target = payload.target === "mac" ? "mac" : "default";
      const repository =
        typeof payload.repository === "string"
          ? advertisedRepositories.get(
              payload.repository.toLocaleLowerCase("en-US"),
            )
          : undefined;
      return {
        mode,
        target,
        ...(mutationScope ? { mutationScope } : {}),
        ...(mode === "dev" && repository ? { repository } : {}),
      };
    }
  } catch {
    // Fall through to the deterministic safety net.
  }

  return {
    mode: "chat",
    target: "default",
  };
}

export function missingDeveloperRepositoryResponse(
  mode: ChatbotExecutionMode,
  repository?: string,
  availableRepositories: string[] = [],
) {
  if (mode !== "dev" || repository) return undefined;
  const choices =
    availableRepositories.length > 0
      ? `\n目前可用的有 ${availableRepositories.map((value) => `\`${value}\``).join(" ")}`
      : "";
  return `這題要碰程式碼 但我還不知道是哪個 GitHub repo${choices}\n告訴我是哪個 我就能繼續`;
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

  const query = new URLSearchParams({
    query: memberQuery,
    limit: String(CHATBOT_CONTEXT_LIMITS.memberSearchResults),
  });
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

export async function lookupGuildMembers({
  guildId,
  queries,
  discordRequest,
}: {
  guildId: string;
  queries: string[];
  discordRequest: DiscordRequest;
}) {
  const results = await Promise.all(
    queries
      .slice(0, CHATBOT_CONTEXT_LIMITS.maximumMemberLookups)
      .map(async (query): Promise<ChatbotMemberResult[]> => {
        const member = await resolveGuildMember({
          guildId,
          memberQuery: query,
          discordRequest,
        });
        const names = member ? memberNames(member) : [];
        return names.length > 0 ? [{ query, names }] : [];
      }),
  );

  return results.flat();
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
      .slice(0, CHATBOT_CONTEXT_LIMITS.maximumSearchChannels);
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
  const matches = new Map<string, DiscordMessage>();

  for (const search of queries.slice(
    0,
    CHATBOT_CONTEXT_LIMITS.maximumSearchQueries,
  )) {
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
      limit: String(CHATBOT_CONTEXT_LIMITS.searchResultsPerQuery),
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

    for (
      let attempt = 0;
      attempt < CHATBOT_CONTEXT_LIMITS.searchRetryAttempts;
      attempt += 1
    ) {
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
          if (matches.has(message.id)) continue;
          if (matches.size >= CHATBOT_CONTEXT_LIMITS.maximumSearchResults)
            continue;
          matches.set(message.id, message);
        }
        break;
      }

      if (
        response.code !== 110000 ||
        attempt === CHATBOT_CONTEXT_LIMITS.searchRetryAttempts - 1
      )
        break;
      await Bun.sleep(Math.max(response.retry_after ?? 1, 1) * 1_000);
    }

    if (matches.size >= CHATBOT_CONTEXT_LIMITS.maximumSearchResults) break;
  }

  if (matches.size === 0) return [];

  return [...matches.values()].map((message) =>
    toSearchResult(message, guildId, searchableChannels.names),
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
    limit: String(CHATBOT_CONTEXT_LIMITS.nearbyFetchMessages),
  });
  const messages = await discordRequest<DiscordMessage[]>(
    `/channels/${channelId}/messages?${query}`,
  );

  return messages
    .filter((message) =>
      isConversationContextMessage(message, requestMessageId, botUserId),
    )
    .slice(0, CHATBOT_CONTEXT_LIMITS.nearbyMessages)
    .map((message) => toChatbotMessage(message, botUserId))
    .reverse();
}

export async function getRecentHumanMessages({
  channelId,
  requestMessageId,
  botUserId,
  discordRequest,
  messageLimit = CHATBOT_CONTEXT_LIMITS.maximumHistoryMessages,
  now = new Date(),
}: {
  channelId: string;
  requestMessageId: string;
  botUserId: string;
  discordRequest: DiscordRequest;
  messageLimit?: number;
  now?: Date;
}) {
  const cutoff = new Date(
    now.getTime() - CHATBOT_CONTEXT_LIMITS.historyWindowMs,
  );
  const messages: ChatbotMessage[] = [];
  let before: string | undefined;

  for (;;) {
    const query = new URLSearchParams({
      limit: String(CHATBOT_CONTEXT_LIMITS.historyPageMessages),
    });
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
    if (
      page.length < CHATBOT_CONTEXT_LIMITS.historyPageMessages ||
      !oldestMessage
    ) {
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

export async function postChatbotResponse(
  message: DiscordMessage,
  content: string | string[],
  discordRequest: DiscordRequest,
) {
  const contents = Array.isArray(content) ? content : [content];
  let canPostDirectly = false;

  try {
    const latestMessages = await discordRequest<DiscordMessage[]>(
      `/channels/${message.channel_id}/messages?limit=1`,
    );
    canPostDirectly = latestMessages[0]?.id === message.id;
  } catch {
    // A reply keeps the relationship clear when the latest message is unknown.
  }

  for (const [index, content] of contents.entries()) {
    await discordRequest(`/channels/${message.channel_id}/messages`, {
      method: "POST",
      body:
        canPostDirectly || index > 0
          ? channelMessageBody(content)
          : replyBody(message, content),
    });
  }
}

export async function postMutationApproval(
  message: DiscordMessage,
  approval: ApprovedMutation,
  customId: string,
  discordRequest: DiscordRequest,
) {
  await discordRequest(`/channels/${message.channel_id}/messages`, {
    method: "POST",
    body: {
      ...replyBody(message, mutationApprovalContent(approval)),
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: "允許這次寫入",
              custom_id: customId,
            },
          ],
        },
      ],
    },
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
  approvedMutation,
}: {
  message: ChatbotMention;
  botUserId: string;
  discordRequest: DiscordRequest;
  approvedMutation?: ApprovedMutation;
}) {
  const requesterUserId = message.author?.id;

  if (!requesterUserId || message.author?.bot || message.webhook_id) {
    return false;
  }

  const request = extractChatbotRequest(message, botUserId);
  if (request === null) {
    return false;
  }

  if (
    !isChatbotAuthorized(requesterUserId, message.guild_id, message.channel_id)
  ) {
    if (!message.guild_id) {
      return false;
    }

    await postChatbotResponse(
      message,
      `在這個伺服器裡我暫時只聽 <@${OWNER_DISCORD_USER_ID}> 的 抱歉啦`,
      discordRequest,
    );
    return true;
  }

  const acquired = macAgentBridge.acquireWorkflow();

  if (acquired.status === "offline") {
    await postChatbotResponse(
      message,
      "我現在沒接上工作機 晚點再叫我一次 💤",
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
  let result:
    | MacAgentJobResult
    | { ok: true; content: ""; awaitingApproval: true };
  let searchUnavailable = false;
  try {
    result = await withTyping(message.channel_id, discordRequest, async () => {
      const requestMessage = toChatbotMessage(message, botUserId);
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
      let executionMode: ChatbotExecutionMode = "chat";
      let executionTarget: ChatbotExecutionTarget = "default";
      let mutationScope: ChatbotMutationScope | undefined;
      let selectedRepository: string | undefined;

      if (requesterUserId === OWNER_DISCORD_USER_ID) {
        if (
          approvedMutation &&
          approvedMutation.requestMessageId === message.id
        ) {
          executionMode = approvedMutation.mode;
          executionTarget = approvedMutation.target;
          mutationScope = approvedMutation.mutationScope;
          selectedRepository = approvedMutation.repository;
        } else {
          const routeJob: ChatbotJob = {
            id: randomUUID(),
            requesterUserId,
            purpose: "execution_route",
            channelId: message.channel_id,
            requestMessageId: message.id,
            request,
            requestMessage,
            messages,
            availableRepositories: workflow.availableRepositories,
            ...(workflow.chatbotRepository
              ? { chatbotRepository: workflow.chatbotRepository }
              : {}),
          };
          const routeDispatch = workflow.dispatch(routeJob);
          let route = parseExecutionRoute("", workflow.availableRepositories);
          if (routeDispatch.status === "accepted") {
            const routeResult = await routeDispatch.result;
            route = parseExecutionRoute(
              routeResult.ok ? routeResult.content : "",
              workflow.availableRepositories,
            );
          }
          executionMode = route.mode;
          executionTarget = route.target;
          mutationScope = route.mutationScope;
          selectedRepository = route.repository;
        }

        const missingRepository = missingDeveloperRepositoryResponse(
          executionMode,
          selectedRepository,
          workflow.availableRepositories,
        );
        if (missingRepository) {
          return { ok: true as const, content: missingRepository };
        }
        if (mutationScope && !approvedMutation && selectedRepository) {
          const approval: ApprovedMutation = {
            requestMessageId: message.id,
            mode: "dev",
            target: executionTarget,
            mutationScope,
            repository: selectedRepository,
          };
          const customId = registerMutationApproval(
            message,
            botUserId,
            approval,
          );
          await postMutationApproval(
            message,
            approval,
            customId,
            discordRequest,
          );
          return {
            ok: true as const,
            content: "" as const,
            awaitingApproval: true as const,
          };
        }
        const workerRoute = workflow.route(
          [
            executionMode === "chat" ? "chat" : executionMode,
            ...(executionTarget === "mac" ? (["mac"] as const) : []),
          ],
          selectedRepository,
        );
        if (workerRoute.status !== "accepted") {
          return {
            ok: false as const,
            error:
              workerRoute.status === "busy"
                ? "The compatible worker is busy."
                : "No compatible worker is online.",
          };
        }
      }
      let search: {
        status: "not_requested" | "complete" | "unavailable";
        results: ChatbotMessage[];
      } = { status: "not_requested", results: [] };
      let memberLookup: {
        status: "not_requested" | "complete" | "unavailable";
        results: ChatbotMemberResult[];
      } = { status: "not_requested", results: [] };
      let previousTrace: {
        status: "not_requested" | "complete" | "not_found" | "unavailable";
        trace?: ChatbotTraceContext;
      } = { status: "not_requested" };
      let plan: DiscordContextPlan = {
        historyCount: CHATBOT_CONTEXT_LIMITS.nearbyMessages,
        includePreviousTrace: false,
        memberQueries: [],
        queries: [],
      };

      const plannerJob: ChatbotJob = {
        id: randomUUID(),
        requesterUserId,
        purpose: "context_plan",
        executionMode,
        executionTarget,
        mutationScope,
        repository: selectedRepository,
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

      if (plan.includePreviousTrace) {
        const traceDispatch = workflow.dispatch({
          id: randomUUID(),
          requesterUserId,
          purpose: "trace_lookup",
          channelId: message.channel_id,
          requestMessageId: message.id,
          request,
          requestMessage,
          messages: [],
        });
        if (traceDispatch.status === "accepted") {
          const traceResult = await traceDispatch.result;
          previousTrace = traceResult.ok
            ? parsePreviousTraceLookup(traceResult.content)
            : { status: "unavailable" };
        } else {
          previousTrace = { status: "unavailable" };
        }
      }

      if (message.guild_id) {
        const historyPromise =
          plan.historyCount > CHATBOT_CONTEXT_LIMITS.nearbyMessages
            ? getRecentHumanMessages({
                channelId: message.channel_id,
                requestMessageId: message.id,
                botUserId,
                discordRequest,
                messageLimit: plan.historyCount,
              })
            : Promise.resolve(
                plan.historyCount === 0
                  ? []
                  : messages.slice(-plan.historyCount),
              );
        const searchPromise =
          plan.queries.length > 0
            ? searchGuildMessages({
                guildId: message.guild_id,
                requesterUserId,
                requesterRoleIds: message.member?.roles,
                currentChannelId: message.channel_id,
                requestMessageId: message.id,
                queries: plan.queries,
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
        const memberLookupPromise =
          plan.memberQueries.length > 0
            ? lookupGuildMembers({
                guildId: message.guild_id,
                queries: plan.memberQueries,
                discordRequest,
              })
                .then((results) => ({
                  status: "complete" as const,
                  results,
                }))
                .catch(() => {
                  console.warn("Discord member lookup unavailable.");
                  return {
                    status: "unavailable" as const,
                    results: [] as ChatbotMemberResult[],
                  };
                })
            : Promise.resolve(memberLookup);

        [messages, search, memberLookup] = await Promise.all([
          historyPromise,
          searchPromise,
          memberLookupPromise,
        ]);
        searchUnavailable = search.status === "unavailable";
      } else if (plan.historyCount === 0) {
        messages = [];
      } else if (plan.historyCount <= CHATBOT_CONTEXT_LIMITS.nearbyMessages) {
        messages = messages.slice(-plan.historyCount);
      } else {
        messages = await getRecentHumanMessages({
          channelId: message.channel_id,
          requestMessageId: message.id,
          botUserId,
          discordRequest,
          messageLimit: plan.historyCount,
        });
      }

      const job: ChatbotJob = {
        id: randomUUID(),
        requesterUserId,
        purpose: "answer",
        executionMode,
        executionTarget,
        mutationScope,
        repository: selectedRepository,
        channelId: message.channel_id,
        requestMessageId: message.id,
        request,
        requestMessage,
        messages,
        searchStatus: search.status,
        searchResults: search.results,
        memberLookupStatus: memberLookup.status,
        memberResults: memberLookup.results,
        previousTraceStatus: previousTrace.status,
        previousTrace: previousTrace.trace,
      };
      const dispatch = workflow.dispatch(job);

      if (dispatch.status === "offline") {
        return { ok: false as const, error: "The worker disconnected." };
      }

      if (dispatch.status === "busy") {
        return { ok: false as const, error: "The worker became busy." };
      }

      return dispatch.result;
    });
  } catch (error) {
    console.error(`Chatbot request ${message.id} failed:`, error);
    result = { ok: false, error: "聊天機器人請求失敗" };
  } finally {
    workflow.release();
  }
  if ("awaitingApproval" in result) return true;

  const contents = result.ok
    ? formatDiscordAnswers(
        searchUnavailable
          ? `我剛剛翻不到伺服器的舊訊息 這次回答可能不太完整\n\n${result.content}`
          : result.content,
      )
    : ["我剛剛卡住了 晚點再叫我一次"];

  await postChatbotResponse(message, contents, discordRequest);

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
