import { describe, expect, test } from "bun:test";

import {
  canRunChatbotRequest,
  chatbotAccessTier,
  isPrivilegedChatbotRequest,
  OWNER_DISCORD_USER_ID,
} from "./access";

describe("chatbot access policy", () => {
  test("separates the owner from community users", () => {
    expect(chatbotAccessTier(OWNER_DISCORD_USER_ID)).toBe("owner");
    expect(chatbotAccessTier("community-member")).toBe("community");
  });

  test("keeps trivial community requests available", () => {
    expect(isPrivilegedChatbotRequest("summarize this conversation")).toBe(
      false,
    );
    expect(isPrivilegedChatbotRequest("這篇網址在講什麼")).toBe(false);
    expect(canRunChatbotRequest("community-member", "幫我整理聊天")).toBe(true);
  });

  test("blocks GitHub and coding work for community users", () => {
    const requests = [
      "review this PR",
      "https://github.com/Hsiii/health-check-system/pull/42",
      "幫我審查這個 PR",
      "create a GitHub issue from this discussion",
      "幫我執行這個專案的測試",
    ];

    for (const request of requests) {
      expect(isPrivilegedChatbotRequest(request)).toBe(true);
      expect(canRunChatbotRequest("community-member", request)).toBe(false);
      expect(canRunChatbotRequest(OWNER_DISCORD_USER_ID, request)).toBe(true);
    }
  });
});
