export const OWNER_DISCORD_USER_ID = "917446775873343600";

export type ChatbotAccessTier = "community" | "owner";

const GITHUB_PULL_REQUEST_URL =
  /https?:\/\/(?:www\.)?github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/iu;

const PRIVILEGED_REQUEST_PATTERNS = [
  /\b(?:review|inspect|audit|analy[sz]e|check)\b[^\n]{0,48}\b(?:pr|pull request|diff|code changes?)\b/iu,
  /\b(?:create|open|update|edit|close|comment on|merge)\b[^\n]{0,48}\b(?:github )?(?:issue|pr|pull request)\b/iu,
  /\b(?:implement|fix|edit|write|commit|push|deploy|install|run|execute)\b[^\n]{0,48}\b(?:code|repository|repo|project|command|script|test|build)\b/iu,
  /(?:審查|review|檢查|分析).{0,24}(?:PR|pull request|程式碼|代碼|diff)/iu,
  /(?:建立|新增|修改|更新|關閉|留言|合併).{0,24}(?:GitHub )?(?:issue|PR|pull request)/iu,
  /(?:實作|修復|修改|執行|跑|部署|安裝|commit|push).{0,24}(?:程式碼|代碼|repo|repository|專案|指令|測試|build)/iu,
];

export function chatbotAccessTier(userId: string): ChatbotAccessTier {
  return userId === OWNER_DISCORD_USER_ID ? "owner" : "community";
}

export function isPrivilegedChatbotRequest(content: string) {
  return (
    GITHUB_PULL_REQUEST_URL.test(content) ||
    PRIVILEGED_REQUEST_PATTERNS.some((pattern) => pattern.test(content))
  );
}

export function canRunChatbotRequest(userId: string, content: string) {
  return (
    chatbotAccessTier(userId) === "owner" ||
    !isPrivilegedChatbotRequest(content)
  );
}
