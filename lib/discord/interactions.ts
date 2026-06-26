import {
  JOIN_BRAWL_STARS_CHANNEL_COMMAND_NAME,
  JOIN_WORDLE_CHANNEL_COMMAND_NAME,
  LEAVE_BRAWL_STARS_CHANNEL_COMMAND_NAME,
  LEAVE_WORDLE_CHANNEL_COMMAND_NAME,
} from "./constants";
import { getBrawlStarsRole, getDiscordConfig, getWordleRole } from "./env";
import { isChannelAccessSelect, parseChannelAccessButton } from "./panel";
import {
  applyManagedRoleSelection,
  formatRoleMemberSummary,
  getManagedRolesById,
  getRoleMemberSummary,
} from "./roles";
import { verifyDiscordRequest } from "./verify";

type DiscordInteraction = {
  type: number;
  guild_id?: string;
  data?: {
    component_type?: number;
    name?: string;
    custom_id?: string;
    values?: string[];
  };
  member?: {
    roles?: string[];
    user?: {
      id: string;
    };
  };
  user?: {
    id: string;
  };
};

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function getUserId(interaction: DiscordInteraction) {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

function getMemberRoleIds(interaction: DiscordInteraction) {
  return interaction.member?.roles ?? [];
}

function isGuildAllowed(
  guildId: string | undefined,
  allowedGuildId: string | undefined,
) {
  if (!allowedGuildId) {
    return true;
  }

  return guildId === allowedGuildId;
}

function buildEphemeralResponse(message: string) {
  return {
    type: 4,
    data: {
      flags: 64,
      content: message,
    },
  };
}

async function buildRoleMemberSummaryMessage({
  guildId,
  roleId,
  roleLabel,
  botToken,
}: {
  guildId: string;
  roleId: string;
  roleLabel: string;
  botToken: string;
}) {
  const summary = await getRoleMemberSummary({
    guildId,
    roleId,
    botToken,
  });

  return formatRoleMemberSummary({
    roleLabel,
    memberIds: summary.memberIds,
    totalCount: summary.totalCount,
    usedFallbackCount: summary.usedFallbackCount,
  });
}

async function handleChannelAccessComponent({
  customId,
  selectedRoleIds,
  config,
  guildId,
  userId,
  currentRoleIds,
}: {
  customId: string | undefined;
  selectedRoleIds: string[];
  config: ReturnType<typeof getDiscordConfig>;
  guildId: string;
  userId: string;
  currentRoleIds: string[];
}) {
  const buttonAction = parseChannelAccessButton(customId);

  if (buttonAction) {
    const role = config.managedRoles.find(
      (managedRole) => managedRole.id === buttonAction.roleId,
    );

    if (!role) {
      return buildEphemeralResponse("這個頻道選項已不再由機器人管理。");
    }

    const result = await applyManagedRoleSelection({
      guildId,
      userId,
      botToken: config.botToken,
      currentRoleIds,
      selectedRoleIds: buttonAction.action === "join" ? [role.id] : [],
      managedRolesById: getManagedRolesById([role]),
    });

    let message = result.message;

    if (buttonAction.action === "join") {
      const summary = await buildRoleMemberSummaryMessage({
        guildId,
        roleId: role.id,
        roleLabel: role.label,
        botToken: config.botToken,
      });

      message = `${message}\n\n${summary}`;
    }

    return buildEphemeralResponse(message);
  }

  if (isChannelAccessSelect(customId)) {
    const result = await applyManagedRoleSelection({
      guildId,
      userId,
      botToken: config.botToken,
      currentRoleIds,
      selectedRoleIds,
      managedRolesById: getManagedRolesById(config.managedRoles),
    });

    return buildEphemeralResponse(result.message);
  }

  return null;
}

function buildRoleCommandResponse(message: string) {
  return {
    type: 4,
    data: {
      content: message,
    },
  };
}

export async function handleDiscordInteractionRequest(request: Request) {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  const rawBody = await request.text();

  if (!signature || !timestamp) {
    return new Response("缺少 Discord 簽章標頭", { status: 401 });
  }

  let config;

  try {
    config = getDiscordConfig();
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Discord 機器人設定無效",
      { status: 500 },
    );
  }

  const isValid = verifyDiscordRequest({
    body: rawBody,
    signature,
    timestamp,
    publicKey: config.publicKey,
  });

  if (!isValid) {
    return new Response("Discord 請求簽章無效", { status: 401 });
  }

  const interaction = JSON.parse(rawBody) as DiscordInteraction;
  const commandName = interaction.data?.name;
  const customId = interaction.data?.custom_id;

  if (interaction.type === 1) {
    return jsonResponse({ type: 1 });
  }

  if (!isGuildAllowed(interaction.guild_id, config.guildId)) {
    return jsonResponse({
      type: 4,
      data: {
        flags: 64,
        content: "這個機器人只限指定伺服器使用。",
      },
    });
  }

  const userId = getUserId(interaction);

  if (interaction.type === 3) {
    if (!interaction.guild_id || !userId) {
      return jsonResponse(
        buildEphemeralResponse("互動資料缺少伺服器成員資訊。"),
      );
    }

    try {
      const response = await handleChannelAccessComponent({
        customId,
        selectedRoleIds: interaction.data?.values ?? [],
        config,
        guildId: interaction.guild_id,
        userId,
        currentRoleIds: getMemberRoleIds(interaction),
      });

      if (response) {
        return jsonResponse(response);
      }
    } catch (error) {
      return jsonResponse(
        buildEphemeralResponse(
          error instanceof Error
            ? `無法更新身分組：${error.message}`
            : "無法更新身分組。",
        ),
      );
    }
  }

  const wordleRole = getWordleRole(config.managedRoles);
  const brawlStarsRole = getBrawlStarsRole(config.managedRoles);
  const roleCommand = [
    {
      name: JOIN_WORDLE_CHANNEL_COMMAND_NAME,
      role: wordleRole,
      selectedRoleIds: [wordleRole.id],
      includeMemberSummary: true,
    },
    {
      name: LEAVE_WORDLE_CHANNEL_COMMAND_NAME,
      role: wordleRole,
      selectedRoleIds: [],
      includeMemberSummary: false,
    },
    {
      name: JOIN_BRAWL_STARS_CHANNEL_COMMAND_NAME,
      role: brawlStarsRole,
      selectedRoleIds: [brawlStarsRole.id],
      includeMemberSummary: true,
    },
    {
      name: LEAVE_BRAWL_STARS_CHANNEL_COMMAND_NAME,
      role: brawlStarsRole,
      selectedRoleIds: [],
      includeMemberSummary: false,
    },
  ].find((command) => command.name === commandName);

  if (!roleCommand) {
    return jsonResponse({
      type: 4,
      data: {
        flags: 64,
        content: "不支援的互動類型。",
      },
    });
  }

  if (!interaction.guild_id || !userId) {
    return jsonResponse({
      type: 4,
      data: {
        flags: 64,
        content: "互動資料缺少伺服器成員資訊。",
      },
    });
  }

  const currentRoleIds = getMemberRoleIds(interaction);
  const managedRolesById = getManagedRolesById([roleCommand.role]);

  try {
    const result = await applyManagedRoleSelection({
      guildId: interaction.guild_id,
      userId,
      botToken: config.botToken,
      currentRoleIds,
      selectedRoleIds: roleCommand.selectedRoleIds,
      managedRolesById,
    });

    let message = result.message;

    if (roleCommand.includeMemberSummary) {
      const summary = await buildRoleMemberSummaryMessage({
        guildId: interaction.guild_id,
        roleId: roleCommand.role.id,
        roleLabel: roleCommand.role.label,
        botToken: config.botToken,
      });

      message = `${message}\n\n${summary}`;
    }

    return jsonResponse(buildRoleCommandResponse(message));
  } catch (error) {
    return jsonResponse(
      buildRoleCommandResponse(
        error instanceof Error
          ? `無法更新身分組：${error.message}`
          : "無法更新身分組。",
      ),
    );
  }
}
