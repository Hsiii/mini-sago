import type { ChatbotJob } from "../../../lib/chatbot/protocol";
import { buildAnswerPrompt } from "./answer";
import { buildSearchPlanPrompt } from "./search-plan";

export { ANSWER_INSTRUCTIONS, PROMPT_VERSION } from "./answer";

export function buildCodexPrompt(
  job: ChatbotJob,
  attachmentText: string[],
  ignoredAttachments: string[],
) {
  return job.purpose === "search_plan"
    ? buildSearchPlanPrompt(job)
    : buildAnswerPrompt(job, attachmentText, ignoredAttachments);
}
