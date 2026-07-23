import { describe, expect, test } from "bun:test";

import {
  chatbotAccessTier,
  canUseChatbotCapability,
  OWNER_DISCORD_USER_ID,
} from "./access";

describe("chatbot access policy", () => {
  test("separates the owner from community users", () => {
    expect(chatbotAccessTier(OWNER_DISCORD_USER_ID)).toBe("owner");
    expect(chatbotAccessTier("community-member")).toBe("community");
  });

  test("grants capabilities by requester instead of request wording", () => {
    expect(canUseChatbotCapability("community-member", "chat")).toBe(true);
    expect(canUseChatbotCapability("community-member", "dev")).toBe(false);
    expect(canUseChatbotCapability("community-member", "mac")).toBe(false);
    expect(canUseChatbotCapability("community-member", "execution_route")).toBe(
      false,
    );
    expect(canUseChatbotCapability(OWNER_DISCORD_USER_ID, "dev")).toBe(true);
    expect(canUseChatbotCapability(OWNER_DISCORD_USER_ID, "mac")).toBe(true);
    expect(
      canUseChatbotCapability(OWNER_DISCORD_USER_ID, "execution_route"),
    ).toBe(true);
  });
});
