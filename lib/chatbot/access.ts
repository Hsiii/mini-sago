export const OWNER_DISCORD_USER_ID = "917446775873343600";

export type ChatbotAccessTier = "community" | "owner";
export type ChatbotAccessCapability =
  | "chat"
  | "dev"
  | "mac"
  | "execution_route";

const CAPABILITIES_BY_TIER: Record<
  ChatbotAccessTier,
  ReadonlySet<ChatbotAccessCapability>
> = {
  community: new Set(["chat"]),
  owner: new Set(["chat", "dev", "mac", "execution_route"]),
};

export function chatbotAccessTier(userId: string): ChatbotAccessTier {
  return userId === OWNER_DISCORD_USER_ID ? "owner" : "community";
}

export function canUseChatbotCapability(
  userId: string,
  capability: ChatbotAccessCapability,
) {
  return CAPABILITIES_BY_TIER[chatbotAccessTier(userId)].has(capability);
}
