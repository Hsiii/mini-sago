import { describe, expect, test } from "bun:test";

import type { ChatbotJob } from "../chatbot/protocol";
import type { DiscordRequest } from "./chatbot";
import {
  AmbientReactionController,
  DEFAULT_AMBIENT_REACTION_POLICY,
} from "./social-reactions";

const ACCESS_CONFIG = {
  ownerUserId: "917446775873343600",
  guildIds: new Set(["guild-1"]),
  channelIds: new Set<string>(),
};

const MESSAGE = {
  id: "message-1",
  channel_id: "channel-1",
  guild_id: "guild-1",
  content: "websocket 終於修好了",
  timestamp: "2026-07-23T04:00:00.000Z",
  author: {
    id: "member-1",
    username: "member",
  },
  attachments: [],
};

const REACTION_PERMISSIONS = String((1n << 6n) | (1n << 10n) | (1n << 16n));

function discordFixture(requests: string[]) {
  return (async <T>(path: string, options?: { method?: string }) => {
    requests.push(`${options?.method ?? "GET"} ${path}`);
    if (path === "/channels/channel-1") {
      return {
        id: "channel-1",
        type: 0,
        permission_overwrites: [],
      } as T;
    }
    if (path === "/guilds/guild-1/members/bot-1") {
      return { roles: [] } as T;
    }
    if (path === "/guilds/guild-1/roles") {
      return [{ id: "guild-1", permissions: REACTION_PERMISSIONS }] as T;
    }
    if (path === "/guilds/guild-1/emojis") {
      return [
        { id: "emoji-1", name: "sago", animated: true, available: true },
      ] as T;
    }
    if (path.startsWith("/channels/channel-1/messages?")) {
      return [MESSAGE] as T;
    }
    if (path.includes("/reactions/")) return undefined as T;
    throw new Error(`Unexpected Discord request: ${path}`);
  }) satisfies DiscordRequest;
}

function controller({
  output,
  jobs,
  now = Date.parse(MESSAGE.timestamp) + 1_000,
}: {
  output: string;
  jobs: ChatbotJob[];
  now?: number;
}) {
  return new AmbientReactionController({
    now: () => now,
    policy: {
      ...DEFAULT_AMBIENT_REACTION_POLICY,
      evaluationChannelCooldownMs: 0,
      reactionChannelCooldownMs: 0,
      reactionUserCooldownMs: 0,
    },
    dispatch: (job) => {
      jobs.push(job);
      return {
        status: "accepted",
        result: Promise.resolve({ ok: true, content: output }),
      };
    },
    log: () => undefined,
  });
}

describe("ambient Discord reactions", () => {
  test("advertises a permitted reaction tool and executes a Unicode reaction", async () => {
    const requests: string[] = [];
    const jobs: ChatbotJob[] = [];
    const ambient = controller({
      output: '{"action":"discord.add_reaction","emoji":"🎉"}',
      jobs,
    });

    expect(
      await ambient.consider({
        message: MESSAGE,
        botUserId: "bot-1",
        accessConfig: ACCESS_CONFIG,
        discordRequest: discordFixture(requests),
      }),
    ).toBe(true);
    expect(jobs[0]?.purpose).toBe("social_action");
    expect(jobs[0]?.availableTools?.[0]?.name).toBe("discord.add_reaction");
    expect(jobs[0]?.availableTools?.[0]?.metadata).toMatchObject({
      standardUnicodeEmoji: true,
      customEmojis: [{ value: "sago:emoji-1", name: "sago", animated: true }],
    });
    expect(requests).toContain(
      "PUT /channels/channel-1/messages/message-1/reactions/%F0%9F%8E%89/@me",
    );
  });

  test("accepts only advertised custom emojis", async () => {
    const requests: string[] = [];
    const jobs: ChatbotJob[] = [];
    const ambient = controller({
      output: '{"action":"discord.add_reaction","emoji":"other:emoji-2"}',
      jobs,
    });

    expect(
      await ambient.consider({
        message: MESSAGE,
        botUserId: "bot-1",
        accessConfig: ACCESS_CONFIG,
        discordRequest: discordFixture(requests),
      }),
    ).toBe(false);
    expect(requests.some((request) => request.startsWith("PUT "))).toBe(false);
  });

  test("does nothing when the planner chooses ignore", async () => {
    const requests: string[] = [];
    const jobs: ChatbotJob[] = [];
    const ambient = controller({
      output: '{"action":"ignore","emoji":null}',
      jobs,
    });

    expect(
      await ambient.consider({
        message: MESSAGE,
        botUserId: "bot-1",
        accessConfig: ACCESS_CONFIG,
        discordRequest: discordFixture(requests),
      }),
    ).toBe(false);
    expect(requests.some((request) => request.startsWith("PUT "))).toBe(false);
  });

  test("skips messages outside configured community channels", async () => {
    const requests: string[] = [];
    const jobs: ChatbotJob[] = [];
    const ambient = controller({
      output: '{"action":"discord.add_reaction","emoji":"🎉"}',
      jobs,
    });

    expect(
      await ambient.consider({
        message: { ...MESSAGE, guild_id: "other-guild" },
        botUserId: "bot-1",
        accessConfig: ACCESS_CONFIG,
        discordRequest: discordFixture(requests),
      }),
    ).toBe(false);
    expect(jobs).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  test("does not advertise reactions without Discord permission", async () => {
    const requests: string[] = [];
    const jobs: ChatbotJob[] = [];
    const request = discordFixture(requests);
    const deniedRequest = (async <T>(
      path: string,
      options?: { method?: string; body?: unknown },
    ) => {
      if (path === "/guilds/guild-1/roles") {
        return [{ id: "guild-1", permissions: "0" }] as T;
      }
      return request<T>(path, options);
    }) satisfies DiscordRequest;
    const ambient = controller({
      output: '{"action":"discord.add_reaction","emoji":"🎉"}',
      jobs,
    });

    expect(
      await ambient.consider({
        message: MESSAGE,
        botUserId: "bot-1",
        accessConfig: ACCESS_CONFIG,
        discordRequest: deniedRequest,
      }),
    ).toBe(false);
    expect(jobs).toHaveLength(0);
  });
});
