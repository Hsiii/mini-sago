import {
  CHANNEL_ACCESS_JOIN_PREFIX,
  CHANNEL_ACCESS_LEAVE_PREFIX,
  CHANNEL_ACCESS_PANEL_TITLE,
  CHANNEL_ACCESS_SELECT_CUSTOM_ID,
} from "@/lib/discord/constants";
import type { ManagedRole } from "@/lib/discord/env";

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

function maybeEmoji(role: ManagedRole) {
  if (!role.emoji) {
    return undefined;
  }

  return { name: role.emoji };
}

function describeRole(role: ManagedRole) {
  return role.description
    ? `${role.emoji ? `${role.emoji} ` : ""}**${role.label}** - ${role.description}`
    : `${role.emoji ? `${role.emoji} ` : ""}**${role.label}**`;
}

function buildButtonRows(roles: ManagedRole[]): DiscordActionRow[] {
  return roles.slice(0, 5).map((role) => ({
    type: 1,
    components: [
      {
        type: 2,
        style: 1,
        label: `Join ${role.label}`,
        custom_id: `${CHANNEL_ACCESS_JOIN_PREFIX}${role.id}`,
        emoji: maybeEmoji(role),
      },
      {
        type: 2,
        style: 2,
        label: `Leave ${role.label}`,
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
          placeholder: "Choose channel access roles",
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
): ChannelAccessPanelPayload {
  const roleLines =
    roles.length > 0
      ? roles.map((role) => `- ${describeRole(role)}`).join("\n")
      : "- No channel roles are configured yet.";

  const actionHint =
    roles.length <= 5
      ? "Use the buttons below to join or leave a channel."
      : "Use the selector below to choose the channels you want.";

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
