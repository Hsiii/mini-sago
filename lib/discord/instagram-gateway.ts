import { transformInstagramLinks } from "./instagram-links";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const INSTAGRAM_REPOST_WEBHOOK_NAME = "MiniSago Instagram";
const MESSAGE_CONTENT_LIMIT = 2_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const GUILDS_INTENT = 1 << 0;
const GUILD_MESSAGES_INTENT = 1 << 9;
const MESSAGE_CONTENT_INTENT = 1 << 15;

type GatewayPayload = {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
};

type GatewayHello = {
  heartbeat_interval: number;
};

type GatewayReady = {
  session_id: string;
  resume_gateway_url?: string;
  user?: {
    id?: string;
  };
};

type DiscordUser = {
  id?: string;
  username?: string;
  discriminator?: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
};

type DiscordGuildMember = {
  nick?: string | null;
  avatar?: string | null;
  user?: DiscordUser;
};

type DiscordMessageCreate = {
  id: string;
  channel_id: string;
  channel_type?: number;
  guild_id?: string;
  content?: string;
  webhook_id?: string;
  author?: DiscordUser;
  member?: DiscordGuildMember;
};

type DiscordWebhook = {
  id: string;
  name?: string | null;
  token?: string;
  channel_id?: string | null;
};

type DiscordChannel = {
  id: string;
  type?: number;
  parent_id?: string | null;
};

type WebhookTarget = {
  webhook: DiscordWebhook;
  threadId?: string;
};

type InstagramGatewayConfig = {
  botToken: string;
};

function getInstagramGatewayConfig(): InstagramGatewayConfig | null {
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();

  if (!botToken) {
    console.warn("Instagram gateway disabled: DISCORD_BOT_TOKEN is missing.");
    return null;
  }

  return {
    botToken,
  };
}

function isThreadChannelType(channelType: number | undefined) {
  return channelType === 10 || channelType === 11 || channelType === 12;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDisplayName(message: DiscordMessageCreate) {
  return (
    message.member?.nick?.trim() ||
    message.author?.global_name?.trim() ||
    message.author?.username?.trim() ||
    "Instagram"
  ).slice(0, 80);
}

function getAvatarUrl({
  user,
  guildId,
  guildAvatar,
}: {
  user: DiscordUser | undefined;
  guildId?: string;
  guildAvatar?: string | null;
}) {
  const userId = user?.id;

  if (!userId) {
    return undefined;
  }

  if (guildAvatar && guildId) {
    const extension = guildAvatar.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/guilds/${guildId}/users/${userId}/avatars/${guildAvatar}.${extension}`;
  }

  if (user.avatar) {
    const extension = user.avatar.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${userId}/${user.avatar}.${extension}`;
  }

  return `https://cdn.discordapp.com/embed/avatars/${getDefaultAvatarIndex(user)}.png`;
}

function hasCustomAvatar({
  user,
  guildAvatar,
}: {
  user: DiscordUser | undefined;
  guildAvatar?: string | null;
}) {
  return Boolean(guildAvatar || user?.avatar);
}

function getDefaultAvatarIndex(user: DiscordUser | undefined) {
  const discriminator = user?.discriminator;

  if (discriminator && discriminator !== "0") {
    return Number(discriminator) % 5;
  }

  if (!user?.id) {
    return 0;
  }

  return Number((BigInt(user.id) >> 22n) % 6n);
}

function toWebhookExecutionUrl(target: WebhookTarget) {
  const url = new URL(
    `${DISCORD_API_BASE_URL}/webhooks/${target.webhook.id}/${target.webhook.token}`,
  );

  url.searchParams.set("wait", "true");

  if (target.threadId) {
    url.searchParams.set("thread_id", target.threadId);
  }

  return url.toString();
}

function readGatewayMessage(data: MessageEvent["data"]) {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }

  return String(data);
}

function getGatewayCloseReason(code: number) {
  if (code === 4004) {
    return "authentication failed; check DISCORD_BOT_TOKEN";
  }

  if (code === 4013) {
    return "invalid gateway intents requested";
  }

  if (code === 4014) {
    return "disallowed gateway intents; enable the Message Content privileged intent in the Discord Developer Portal";
  }

  return "no specific reason mapped";
}

class InstagramGatewayClient {
  private heartbeatAcked = true;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectAttempts = 0;
  private resumeGatewayUrl: string | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private socket: WebSocket | null = null;
  private stopped = false;
  private botUserId: string | null = null;
  private readonly webhooksByChannelId = new Map<string, DiscordWebhook>();

  constructor(private readonly config: InstagramGatewayConfig) {}

  connect() {
    void this.openSocket(false);
  }

  stop() {
    this.stopped = true;
    this.clearHeartbeat();
    this.socket?.close(1000, "MiniSago shutdown");
  }

  private async openSocket(resume: boolean) {
    const url =
      resume && this.resumeGatewayUrl
        ? `${this.resumeGatewayUrl}?v=10&encoding=json`
        : GATEWAY_URL;

    this.socket = new WebSocket(url);
    this.socket.addEventListener("message", (event) => {
      void this.handleGatewayPayload(event);
    });
    this.socket.addEventListener("close", (event) => {
      this.clearHeartbeat();

      if (this.stopped || !this.shouldReconnect(event.code)) {
        console.warn(
          `Discord gateway closed with code ${event.code}: ${getGatewayCloseReason(event.code)}.`,
        );
        return;
      }

      const canResume = Boolean(this.sessionId && this.sequence !== null);
      void this.reconnect(canResume);
    });
    this.socket.addEventListener("error", () => {
      console.warn("Discord gateway socket error.");
    });
  }

  private async handleGatewayPayload(event: MessageEvent) {
    const payload = JSON.parse(
      readGatewayMessage(event.data),
    ) as GatewayPayload;

    if (typeof payload.s === "number") {
      this.sequence = payload.s;
    }

    switch (payload.op) {
      case 0:
        await this.handleDispatch(payload);
        break;
      case 1:
        this.sendHeartbeat();
        break;
      case 7:
        this.socket?.close(4000, "Discord requested reconnect");
        break;
      case 9:
        await this.handleInvalidSession(Boolean(payload.d));
        break;
      case 10:
        this.handleHello(payload.d as GatewayHello);
        break;
      case 11:
        this.heartbeatAcked = true;
        break;
    }
  }

  private async handleDispatch(payload: GatewayPayload) {
    if (payload.t === "READY") {
      const ready = payload.d as GatewayReady;
      this.sessionId = ready.session_id;
      this.resumeGatewayUrl = ready.resume_gateway_url ?? null;
      this.botUserId = ready.user?.id ?? null;
      this.reconnectAttempts = 0;
      console.log("Discord gateway ready.");
      return;
    }

    if (payload.t === "RESUMED") {
      this.reconnectAttempts = 0;
      console.log("Discord gateway resumed.");
      return;
    }

    if (payload.t === "MESSAGE_CREATE") {
      await this.handleMessageCreate(payload.d as DiscordMessageCreate);
    }
  }

  private handleHello(hello: GatewayHello) {
    this.startHeartbeat(hello.heartbeat_interval);

    if (this.sessionId && this.sequence !== null) {
      this.resume();
      return;
    }

    this.identify();
  }

  private startHeartbeat(intervalMs: number) {
    this.clearHeartbeat();
    this.heartbeatAcked = true;

    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAcked) {
        this.socket?.close(4000, "Heartbeat ACK timeout");
        return;
      }

      this.sendHeartbeat();
    }, intervalMs);

    setTimeout(() => this.sendHeartbeat(), Math.random() * intervalMs);
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private sendHeartbeat() {
    this.heartbeatAcked = false;
    this.send({
      op: 1,
      d: this.sequence,
    });
  }

  private identify() {
    this.send({
      op: 2,
      d: {
        token: this.config.botToken,
        intents: GUILDS_INTENT | GUILD_MESSAGES_INTENT | MESSAGE_CONTENT_INTENT,
        properties: {
          os: process.platform,
          browser: "minisago",
          device: "minisago",
        },
      },
    });
  }

  private resume() {
    this.send({
      op: 6,
      d: {
        token: this.config.botToken,
        session_id: this.sessionId,
        seq: this.sequence,
      },
    });
  }

  private send(payload: GatewayPayload) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify(payload));
  }

  private async handleInvalidSession(canResume: boolean) {
    if (!canResume) {
      this.sessionId = null;
      this.sequence = null;
      this.resumeGatewayUrl = null;
    }

    await sleep(1_000 + Math.random() * 4_000);
    this.socket?.close(4000, "Invalid session");
  }

  private shouldReconnect(code: number) {
    return ![4004, 4010, 4011, 4013, 4014].includes(code);
  }

  private async reconnect(canResume: boolean) {
    const delay = Math.min(
      1_000 * 2 ** this.reconnectAttempts,
      MAX_RECONNECT_DELAY_MS,
    );

    this.reconnectAttempts += 1;
    await sleep(delay);

    if (!this.stopped) {
      await this.openSocket(canResume);
    }
  }

  private async handleMessageCreate(message: DiscordMessageCreate) {
    if (!this.shouldTransformMessage(message)) {
      return;
    }

    const transformed = transformInstagramLinks(message.content ?? "");

    if (!transformed.changed) {
      return;
    }

    if (transformed.content.length > MESSAGE_CONTENT_LIMIT) {
      console.warn(
        `Skipped Instagram transform for message ${message.id}: transformed content exceeds ${MESSAGE_CONTENT_LIMIT} characters.`,
      );
      return;
    }

    try {
      const webhookTarget = await this.getWebhookTarget(message);
      await this.deleteMessage(message);
      await this.executeWebhook(webhookTarget, message, transformed.content);
    } catch (error) {
      console.error(
        `Failed to transform Instagram link for message ${message.id}:`,
        error,
      );
    }
  }

  private shouldTransformMessage(message: DiscordMessageCreate) {
    if (!message.guild_id || !message.content) {
      return false;
    }

    if (message.webhook_id || message.author?.bot) {
      return false;
    }

    return message.author?.id !== this.botUserId;
  }

  private async getWebhookTarget(
    message: DiscordMessageCreate,
  ): Promise<WebhookTarget> {
    if (!isThreadChannelType(message.channel_type)) {
      return {
        webhook: await this.getOrCreateWebhook(message.channel_id),
      };
    }

    const channel = await this.discordRequest<DiscordChannel>(
      `/channels/${message.channel_id}`,
    );

    if (!channel.parent_id) {
      throw new Error(`Thread ${message.channel_id} has no parent channel.`);
    }

    return {
      webhook: await this.getOrCreateWebhook(channel.parent_id),
      threadId: message.channel_id,
    };
  }

  private async getOrCreateWebhook(channelId: string) {
    const cachedWebhook = this.webhooksByChannelId.get(channelId);

    if (cachedWebhook?.token) {
      return cachedWebhook;
    }

    const webhooks = await this.discordRequest<DiscordWebhook[]>(
      `/channels/${channelId}/webhooks`,
    );
    const existingWebhook = webhooks.find(
      (webhook) =>
        webhook.name === INSTAGRAM_REPOST_WEBHOOK_NAME &&
        Boolean(webhook.token),
    );

    if (existingWebhook) {
      this.webhooksByChannelId.set(channelId, existingWebhook);
      return existingWebhook;
    }

    const webhook = await this.discordRequest<DiscordWebhook>(
      `/channels/${channelId}/webhooks`,
      {
        method: "POST",
        body: {
          name: INSTAGRAM_REPOST_WEBHOOK_NAME,
        },
      },
    );

    this.webhooksByChannelId.set(channelId, webhook);

    return webhook;
  }

  private async deleteMessage(message: DiscordMessageCreate) {
    await this.discordRequest(
      `/channels/${message.channel_id}/messages/${message.id}`,
      {
        method: "DELETE",
      },
    );
  }

  private async executeWebhook(
    target: WebhookTarget,
    message: DiscordMessageCreate,
    content: string,
  ) {
    if (!target.webhook.token) {
      throw new Error(`Webhook ${target.webhook.id} is missing a token.`);
    }

    const body: Record<string, unknown> = {
      content,
      username: getDisplayName(message),
      allowed_mentions: {
        parse: [],
      },
    };
    const avatarUrl = await this.getMessageAuthorAvatarUrl(message);

    if (avatarUrl) {
      body.avatar_url = avatarUrl;
    }

    await this.fetchJson(toWebhookExecutionUrl(target), {
      method: "POST",
      body,
      authenticated: false,
    });
  }

  private async getMessageAuthorAvatarUrl(message: DiscordMessageCreate) {
    const gatewayAvatarUrl = getAvatarUrl({
      user: message.author,
      guildId: message.guild_id,
      guildAvatar: message.member?.avatar,
    });

    if (
      hasCustomAvatar({
        user: message.author,
        guildAvatar: message.member?.avatar,
      })
    ) {
      return gatewayAvatarUrl;
    }

    if (message.guild_id && message.author?.id) {
      try {
        const member = await this.discordRequest<DiscordGuildMember>(
          `/guilds/${message.guild_id}/members/${message.author.id}`,
        );

        return getAvatarUrl({
          user: member.user ?? message.author,
          guildId: message.guild_id,
          guildAvatar: member.avatar,
        });
      } catch (error) {
        console.warn(
          `Failed to refresh avatar for user ${message.author.id}; falling back to gateway payload.`,
          error,
        );
      }
    }

    return gatewayAvatarUrl;
  }

  private async discordRequest<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
    } = {},
  ) {
    return this.fetchJson<T>(`${DISCORD_API_BASE_URL}${path}`, {
      ...options,
      authenticated: true,
    });
  }

  private async fetchJson<T>(
    url: string,
    options: {
      method?: string;
      body?: unknown;
      authenticated: boolean;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {};

    if (options.authenticated) {
      headers.Authorization = `Bot ${this.config.botToken}`;
    }

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (response.ok) {
      if (response.status === 204) {
        return undefined as T;
      }

      return (await response.json()) as T;
    }

    const body = await response.text();
    throw new Error(`${response.status} ${body}`);
  }
}

export function startInstagramGateway() {
  const config = getInstagramGatewayConfig();

  if (!config) {
    return null;
  }

  const client = new InstagramGatewayClient(config);
  client.connect();

  return client;
}
