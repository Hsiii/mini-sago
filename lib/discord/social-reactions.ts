import { randomUUID } from "node:crypto";

import type { ChatbotAccessConfig } from "../chatbot/access";
import {
  macAgentBridge,
  type DispatchResult,
  type MacAgentJobResult,
} from "../chatbot/bridge";
import type { ChatbotJob, ChatbotToolCapability } from "../chatbot/protocol";
import {
  getNearbyHumanMessages,
  isChatbotAuthorized,
  toChatbotMessage,
  type ChatbotMention,
  type DiscordRequest,
} from "./chatbot";
import {
  canAddDiscordReactions,
  channelPermissions,
  type DiscordPermissionOverwrite,
  type DiscordPermissionRole,
} from "./permissions";

const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

export const DEFAULT_AMBIENT_REACTION_POLICY = {
  maximumMessageAgeMs: 2 * 60_000,
  evaluationChannelCooldownMs: 2 * 60_000,
  reactionChannelCooldownMs: 10 * 60_000,
  reactionUserCooldownMs: 30 * 60_000,
  maximumEvaluationsPerHour: 30,
  maximumReactionsPerHour: 6,
  capabilityCacheMs: 10 * 60_000,
} as const;

type AmbientReactionPolicy = {
  [Key in keyof typeof DEFAULT_AMBIENT_REACTION_POLICY]: number;
};

type DiscordChannel = {
  id: string;
  type?: number;
  parent_id?: string | null;
  permission_overwrites?: DiscordPermissionOverwrite[];
};

type DiscordGuildMember = {
  roles?: string[];
};

type DiscordEmoji = {
  id: string;
  name?: string | null;
  animated?: boolean;
  available?: boolean;
};

type SocialActionDecision =
  | { action: "ignore"; emoji: null }
  | { action: "discord.add_reaction"; emoji: string };

type CachedTools = {
  expiresAt: number;
  tools: ChatbotToolCapability[];
  customEmojiValues: Set<string>;
};

type ConsiderAmbientReactionOptions = {
  message: ChatbotMention;
  botUserId: string;
  accessConfig: ChatbotAccessConfig;
  discordRequest: DiscordRequest;
};

function parseSocialActionDecision(content: string): SocialActionDecision {
  try {
    const value = JSON.parse(content) as {
      action?: unknown;
      emoji?: unknown;
    };
    if (value.action === "ignore" && value.emoji === null) {
      return { action: "ignore", emoji: null };
    }
    if (
      value.action === "discord.add_reaction" &&
      typeof value.emoji === "string"
    ) {
      return { action: value.action, emoji: value.emoji.trim() };
    }
  } catch {
    // Invalid model output is always a no-op.
  }
  return { action: "ignore", emoji: null };
}

function isStandardUnicodeEmoji(value: string) {
  if (!value || value.length > 32 || /\s/u.test(value)) return false;
  const segments = [
    ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value),
  ];
  return (
    segments.length === 1 &&
    /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3)/u.test(value)
  );
}

function validReactionEmoji(value: string, customEmojiValues: Set<string>) {
  return customEmojiValues.has(value) || isStandardUnicodeEmoji(value);
}

function freshHumanMessage(
  message: ChatbotMention,
  botUserId: string,
  now: number,
  maximumAgeMs: number,
) {
  if (
    !message.guild_id ||
    !message.author?.id ||
    message.author.id === botUserId ||
    message.author.bot ||
    message.webhook_id
  ) {
    return false;
  }
  if (
    !message.content?.trim() &&
    !message.attachments?.length &&
    !message.embeds?.length &&
    !message.sticker_items?.length
  ) {
    return false;
  }
  const timestamp = Date.parse(message.timestamp);
  return (
    Number.isFinite(timestamp) &&
    timestamp <= now + 30_000 &&
    now - timestamp <= maximumAgeMs
  );
}

function pruneWindow(values: number[], cutoff: number) {
  while (values[0] !== undefined && values[0] < cutoff) values.shift();
}

function pruneTimes(values: Map<string, number>, cutoff: number) {
  for (const [key, timestamp] of values) {
    if (timestamp < cutoff) values.delete(key);
  }
}

export class AmbientReactionController {
  private capabilityCache = new Map<string, CachedTools>();
  private evaluationTimes: number[] = [];
  private lastEvaluationByChannel = new Map<string, number>();
  private lastEvaluationByUser = new Map<string, number>();
  private lastReactionByChannel = new Map<string, number>();
  private lastReactionByUser = new Map<string, number>();
  private reactionTimes: number[] = [];

  constructor(
    private readonly options: {
      now?: () => number;
      dispatch?: (job: ChatbotJob) => DispatchResult;
      policy?: AmbientReactionPolicy;
      log?: (event: Record<string, unknown>) => void;
    } = {},
  ) {}

  private get now() {
    return this.options.now ?? Date.now;
  }

  private get policy() {
    return this.options.policy ?? DEFAULT_AMBIENT_REACTION_POLICY;
  }

  private async permissionChannel(
    channel: DiscordChannel,
    discordRequest: DiscordRequest,
  ) {
    if (THREAD_CHANNEL_TYPES.has(channel.type ?? -1) && channel.parent_id) {
      return discordRequest<DiscordChannel>(`/channels/${channel.parent_id}`);
    }
    return channel;
  }

  private async discoverTools({
    guildId,
    channelId,
    botUserId,
    discordRequest,
  }: {
    guildId: string;
    channelId: string;
    botUserId: string;
    discordRequest: DiscordRequest;
  }) {
    const now = this.now();
    const cacheKey = `${guildId}:${channelId}:${botUserId}`;
    const cached = this.capabilityCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached;

    const [channel, member, roles, emojis] = await Promise.all([
      discordRequest<DiscordChannel>(`/channels/${channelId}`),
      discordRequest<DiscordGuildMember>(
        `/guilds/${guildId}/members/${botUserId}`,
      ),
      discordRequest<DiscordPermissionRole[]>(`/guilds/${guildId}/roles`),
      discordRequest<DiscordEmoji[]>(`/guilds/${guildId}/emojis`).catch(
        () => [],
      ),
    ]);
    const permissionChannel = await this.permissionChannel(
      channel,
      discordRequest,
    );
    const permissions = channelPermissions({
      guildId,
      botUserId,
      memberRoleIds: member.roles ?? [],
      roles,
      overwrites: permissionChannel.permission_overwrites ?? [],
    });
    const customEmojis = emojis.flatMap((emoji) => {
      const name = emoji.name?.trim();
      if (!name || emoji.available === false) return [];
      return [
        {
          value: `${name}:${emoji.id}`,
          name,
          ...(emoji.animated ? { animated: true } : {}),
        },
      ];
    });
    const customEmojiValues = new Set(customEmojis.map((emoji) => emoji.value));
    const tools: ChatbotToolCapability[] = canAddDiscordReactions(permissions)
      ? [
          {
            name: "discord.add_reaction",
            risk: "ambient",
            description:
              "Add one reaction as MiniSago to the current Discord message.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["emoji"],
              properties: {
                emoji: { type: "string" },
              },
            },
            metadata: {
              target: "current_message",
              standardUnicodeEmoji: true,
              customEmojis,
            },
          },
        ]
      : [];
    const discovered = {
      expiresAt: now + this.policy.capabilityCacheMs,
      tools,
      customEmojiValues,
    };
    this.capabilityCache.set(cacheKey, discovered);
    return discovered;
  }

  async consider({
    message,
    botUserId,
    accessConfig,
    discordRequest,
  }: ConsiderAmbientReactionOptions) {
    const now = this.now();
    const policy = this.policy;
    const authorId = message.author?.id;
    pruneTimes(
      this.lastEvaluationByChannel,
      now - policy.evaluationChannelCooldownMs,
    );
    pruneTimes(
      this.lastEvaluationByUser,
      now - policy.evaluationChannelCooldownMs,
    );
    pruneTimes(
      this.lastReactionByChannel,
      now - policy.reactionChannelCooldownMs,
    );
    pruneTimes(this.lastReactionByUser, now - policy.reactionUserCooldownMs);
    for (const [key, cached] of this.capabilityCache) {
      if (cached.expiresAt <= now) this.capabilityCache.delete(key);
    }
    if (
      !authorId ||
      !freshHumanMessage(message, botUserId, now, policy.maximumMessageAgeMs) ||
      !message.guild_id ||
      !(
        accessConfig.guildIds.has(message.guild_id) ||
        accessConfig.channelIds.has(message.channel_id)
      ) ||
      !isChatbotAuthorized(
        authorId,
        accessConfig,
        message.guild_id,
        message.channel_id,
      )
    ) {
      return false;
    }

    pruneWindow(this.evaluationTimes, now - 60 * 60_000);
    pruneWindow(this.reactionTimes, now - 60 * 60_000);
    if (
      this.evaluationTimes.length >= policy.maximumEvaluationsPerHour ||
      this.reactionTimes.length >= policy.maximumReactionsPerHour ||
      now -
        (this.lastEvaluationByChannel.get(message.channel_id) ??
          Number.NEGATIVE_INFINITY) <
        policy.evaluationChannelCooldownMs ||
      now -
        (this.lastEvaluationByUser.get(authorId) ?? Number.NEGATIVE_INFINITY) <
        policy.evaluationChannelCooldownMs ||
      now -
        (this.lastReactionByChannel.get(message.channel_id) ??
          Number.NEGATIVE_INFINITY) <
        policy.reactionChannelCooldownMs ||
      now -
        (this.lastReactionByUser.get(authorId) ?? Number.NEGATIVE_INFINITY) <
        policy.reactionUserCooldownMs
    ) {
      return false;
    }

    this.lastEvaluationByChannel.set(message.channel_id, now);
    this.lastEvaluationByUser.set(authorId, now);
    this.evaluationTimes.push(now);

    let discovered: CachedTools;
    try {
      discovered = await this.discoverTools({
        guildId: message.guild_id,
        channelId: message.channel_id,
        botUserId,
        discordRequest,
      });
    } catch {
      return false;
    }
    if (discovered.tools.length === 0) return false;

    const messages = await getNearbyHumanMessages({
      channelId: message.channel_id,
      requestMessageId: message.id,
      botUserId,
      discordRequest,
    }).catch(() => []);
    const job: ChatbotJob = {
      id: randomUUID(),
      requesterUserId: authorId,
      purpose: "social_action",
      channelId: message.channel_id,
      requestMessageId: message.id,
      request: message.content?.trim() ?? "",
      requestMessage: toChatbotMessage(message, botUserId),
      messages,
      availableTools: discovered.tools,
    };
    const dispatch = (
      this.options.dispatch ??
      ((candidate) => macAgentBridge.dispatch(candidate, ["chat"]))
    )(job);
    if (dispatch.status !== "accepted") return false;

    const result: MacAgentJobResult = await dispatch.result;
    if (!result.ok) return false;
    const decision = parseSocialActionDecision(result.content);
    if (
      decision.action !== "discord.add_reaction" ||
      !validReactionEmoji(decision.emoji, discovered.customEmojiValues)
    ) {
      return false;
    }

    const completedAt = this.now();
    if (
      completedAt - Date.parse(message.timestamp) >
        policy.maximumMessageAgeMs ||
      this.reactionTimes.length >= policy.maximumReactionsPerHour
    ) {
      return false;
    }

    await discordRequest(
      `/channels/${message.channel_id}/messages/${message.id}/reactions/${encodeURIComponent(decision.emoji)}/@me`,
      { method: "PUT" },
    );
    this.reactionTimes.push(completedAt);
    this.lastReactionByChannel.set(message.channel_id, completedAt);
    this.lastReactionByUser.set(authorId, completedAt);
    (
      this.options.log ??
      ((event) => console.log("MiniSago social action:", JSON.stringify(event)))
    )({
      action: decision.action,
      guildId: message.guild_id,
      channelId: message.channel_id,
      messageId: message.id,
      emoji: decision.emoji,
    });
    return true;
  }
}
