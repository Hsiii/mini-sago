const botToken = process.env.DISCORD_BOT_TOKEN;
const channelId =
  process.argv[2] ?? process.env.DISCORD_CHANNEL_ACCESS_CHANNEL_ID;

const panelTitle = "遊戲頻道入口";
const legacyPanelTitles = ["頻道權限", panelTitle];
const joinPrefix = "wm31:channel-access:join:";
const leavePrefix = "wm31:channel-access:leave:";
const selectCustomId = "wm31:channel-access:select:v1";
const guildId = process.env.DISCORD_GUILD_ID ?? "1282936453134815275";
const wordleRoleId = "1451976411152781466";
const brawlStarsRoleId = "1450774352386719775";

const defaultRoles = [
  {
    id: "1451976411152781466",
    label: "Wordle Channel",
    description: "Access to the Wordle channel",
    emoji: "🟩",
  },
  {
    id: "1450774352386719775",
    label: "Brawl Stars Channel",
    description: "Access to the Brawl Stars channel",
    emoji: "⭐",
  },
];

if (!botToken) {
  console.error("DISCORD_BOT_TOKEN is required.");
  process.exit(1);
}

if (!channelId) {
  console.error(
    "Provide a channel ID argument or DISCORD_CHANNEL_ACCESS_CHANNEL_ID.",
  );
  process.exit(1);
}

function parseManagedRoles() {
  const rawValue = process.env.SELF_ASSIGNABLE_ROLES;

  if (!rawValue) {
    return defaultRoles;
  }

  const roles = JSON.parse(rawValue);

  if (!Array.isArray(roles)) {
    throw new Error("SELF_ASSIGNABLE_ROLES must be a JSON array.");
  }

  if (roles.length > 25) {
    throw new Error("Discord select menus support at most 25 role options.");
  }

  return roles.map((role, index) => {
    const id = String(role.id ?? "").trim();
    const label = String(role.label ?? "").trim();
    const description =
      typeof role.description === "string"
        ? role.description.trim()
        : undefined;
    const emoji =
      typeof role.emoji === "string" ? role.emoji.trim() : undefined;

    if (!/^\d{17,20}$/.test(id)) {
      throw new Error(`Role at index ${index} is missing a valid ID.`);
    }

    if (!label) {
      throw new Error(`Role at index ${index} is missing a label.`);
    }

    return { id, label, description, emoji };
  });
}

function maybeEmoji(role) {
  if (!role.emoji) {
    return undefined;
  }

  return { name: role.emoji };
}

function getRoleTitle(role) {
  if (role.id === wordleRoleId) {
    return "Wordle";
  }

  if (role.id === brawlStarsRoleId) {
    return "荒野亂鬥";
  }

  return role.label;
}

function formatCount(count) {
  return typeof count === "number" ? `${count} 人` : "讀取中";
}

function describeRoleGroup(role, counts) {
  const title = getRoleTitle(role);
  const description = role.description ? `\n${role.description}` : "";

  return `**${role.emoji ? `${role.emoji} ` : ""}${title}**\n目前成員：${formatCount(counts[role.id])}${description}`;
}

function buildButtonRows(roles) {
  return roles.slice(0, 5).map((role) => ({
    type: 1,
    components: [
      {
        type: 2,
        style: 1,
        label: `加入 ${getRoleTitle(role)}`,
        custom_id: `${joinPrefix}${role.id}`,
        emoji: maybeEmoji(role),
      },
      {
        type: 2,
        style: 2,
        label: `離開 ${getRoleTitle(role)}`,
        custom_id: `${leavePrefix}${role.id}`,
        emoji: maybeEmoji(role),
      },
    ],
  }));
}

function buildSelectRow(roles) {
  if (roles.length === 0) {
    return [];
  }

  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: selectCustomId,
          placeholder: "選擇要加入的頻道",
          min_values: 0,
          max_values: roles.length,
          options: roles.map((role) => ({
            label: role.label,
            value: role.id,
            description: role.description,
            emoji: maybeEmoji(role),
          })),
        },
      ],
    },
  ];
}

function buildPanelPayload(roles, counts) {
  const roleLines =
    roles.length > 0
      ? roles.map((role) => describeRoleGroup(role, counts)).join("\n\n")
      : "- 目前還沒有設定可自助加入的頻道。";

  const actionHint = "不用輸入指令，直接用下方按鈕加入或離開遊戲頻道。";

  return {
    content: `**${panelTitle}**\n${actionHint}\n\n${roleLines}`,
    components:
      roles.length <= 5 ? buildButtonRows(roles) : buildSelectRow(roles),
    allowed_mentions: {
      parse: [],
    },
  };
}

async function discordApi(path, options = {}) {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (response.ok) {
    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  const body = await response.text();
  throw new Error(`${response.status} ${body}`);
}

async function findExistingPanelMessage() {
  const messages = await discordApi(`/channels/${channelId}/messages?limit=50`);

  return messages.find(
    (message) =>
      message.author?.bot === true &&
      typeof message.content === "string" &&
      legacyPanelTitles.some((title) =>
        message.content.startsWith(`**${title}**`),
      ),
  );
}

async function fetchRoleCounts(roles) {
  try {
    const roleCounts = await discordApi(
      `/guilds/${guildId}/roles/member-counts`,
    );

    return Object.fromEntries(
      roles.map((role) => [role.id, roleCounts[role.id] ?? 0]),
    );
  } catch {
    return {};
  }
}

const roles = parseManagedRoles();
const counts = await fetchRoleCounts(roles);
const payload = buildPanelPayload(roles, counts);
const existingMessage = await findExistingPanelMessage();

const message = existingMessage
  ? await discordApi(`/channels/${channelId}/messages/${existingMessage.id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    })
  : await discordApi(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

console.log(
  `${existingMessage ? "Updated" : "Created"} channel access panel ${message.id} in channel ${channelId}.`,
);
