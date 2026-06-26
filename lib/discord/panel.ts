import {
  BRAWL_STARS_ROLE_ID,
  CHANNEL_ACCESS_JOIN_PREFIX,
  CHANNEL_ACCESS_LEAVE_PREFIX,
  CHANNEL_ACCESS_PANEL_TITLE,
  CHANNEL_ACCESS_SELECT_CUSTOM_ID,
  WORDLE_ROLE_ID,
} from "./constants";
import type { ManagedRole } from "./env";

type DiscordEmoji = {
  name: string;
};

type DiscordButton = {
  type: 2;
  style: 1 | 2;
  label: string;
  custom_id: string;
  emoji?: DiscordEmoji;
};

type DiscordStringSelect = {
  type: 3;
  custom_id: string;
  placeholder: string;
  min_values: number;
  max_values: number;
  options: {
    label: string;
    value: string;
    description?: string;
    emoji?: DiscordEmoji;
  }[];
};

type DiscordActionRow = {
  type: 1;
  components: (DiscordButton | DiscordStringSelect)[];
};

export type ChannelAccessPanelPayload = {
  content: string;
  components: DiscordActionRow[];
  allowed_mentions: {
    parse: [];
  };
};

export type ChannelAccessButtonAction = {
  action: "join" | "leave";
  roleId: string;
};

export type ChannelAccessRoleCounts = Record<string, number | undefined>;

function maybeEmoji(role: ManagedRole) {
  if (!role.emoji) {
    return undefined;
  }

  return { name: role.emoji };
}

function getRoleTitle(role: ManagedRole) {
  if (role.id === WORDLE_ROLE_ID) {
    return "Wordle";
  }

  if (role.id === BRAWL_STARS_ROLE_ID) {
    return "荒野亂鬥";
  }

  return role.label;
}

function formatCount(count: number | undefined) {
  return typeof count === "number" ? `${count} 人` : "讀取中";
}

function describeRoleGroup(role: ManagedRole, counts: ChannelAccessRoleCounts) {
  const title = getRoleTitle(role);
  const description = role.description ? `\n${role.description}` : "";

  return `**${role.emoji ? `${role.emoji} ` : ""}${title}**\n目前成員：${formatCount(counts[role.id])}${description}`;
}

function buildButtonRows(roles: ManagedRole[]): DiscordActionRow[] {
  return roles.slice(0, 5).map((role) => ({
    type: 1,
    components: [
      {
        type: 2,
        style: 1,
        label: `加入 ${getRoleTitle(role)}`,
        custom_id: `${CHANNEL_ACCESS_JOIN_PREFIX}${role.id}`,
        emoji: maybeEmoji(role),
      },
      {
        type: 2,
        style: 2,
        label: `離開 ${getRoleTitle(role)}`,
        custom_id: `${CHANNEL_ACCESS_LEAVE_PREFIX}${role.id}`,
        emoji: maybeEmoji(role),
      },
    ],
  }));
}

function buildSelectRow(roles: ManagedRole[]): DiscordActionRow[] {
  if (roles.length === 0) {
    return [];
  }

  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: CHANNEL_ACCESS_SELECT_CUSTOM_ID,
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

export function buildChannelAccessPanel(
  roles: ManagedRole[],
  counts: ChannelAccessRoleCounts = {},
): ChannelAccessPanelPayload {
  const roleLines =
    roles.length > 0
      ? roles.map((role) => describeRoleGroup(role, counts)).join("\n\n")
      : "- 目前還沒有設定可自助加入的頻道。";

  const actionHint = "不用輸入指令，直接用下方按鈕加入或離開遊戲頻道。";

  return {
    content: `**${CHANNEL_ACCESS_PANEL_TITLE}**\n${actionHint}\n\n${roleLines}`,
    components:
      roles.length <= 5 ? buildButtonRows(roles) : buildSelectRow(roles),
    allowed_mentions: {
      parse: [],
    },
  };
}

export function parseChannelAccessButton(
  customId: string | undefined,
): ChannelAccessButtonAction | null {
  if (!customId) {
    return null;
  }

  if (customId.startsWith(CHANNEL_ACCESS_JOIN_PREFIX)) {
    return {
      action: "join",
      roleId: customId.slice(CHANNEL_ACCESS_JOIN_PREFIX.length),
    };
  }

  if (customId.startsWith(CHANNEL_ACCESS_LEAVE_PREFIX)) {
    return {
      action: "leave",
      roleId: customId.slice(CHANNEL_ACCESS_LEAVE_PREFIX.length),
    };
  }

  return null;
}

export function isChannelAccessSelect(customId: string | undefined) {
  return customId === CHANNEL_ACCESS_SELECT_CUSTOM_ID;
}
