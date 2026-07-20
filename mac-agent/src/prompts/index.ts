import type { ChatbotJob } from "../../../lib/chatbot/protocol";
import { buildAnswerPrompt } from "./answer";
import {
  buildContextPlanPrompt,
  CONTEXT_PLAN_OUTPUT_SCHEMA,
} from "./context-plan";

export { ANSWER_INSTRUCTIONS, PROMPT_VERSION } from "./answer";
export { CONTEXT_PLAN_OUTPUT_SCHEMA } from "./context-plan";

export function buildCodexPrompt(
  job: ChatbotJob,
  attachmentText: string[],
  ignoredAttachments: string[],
) {
  return job.purpose === "context_plan"
    ? buildContextPlanPrompt(job)
    : buildAnswerPrompt(job, attachmentText, ignoredAttachments);
}

export function outputSchemaForJob(job: ChatbotJob) {
  return job.purpose === "context_plan"
    ? CONTEXT_PLAN_OUTPUT_SCHEMA
    : undefined;
}
