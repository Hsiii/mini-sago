import type { ChatbotJob } from "../../../lib/chatbot/protocol";
import { buildAnswerPrompt } from "./answer";
import {
  buildContextPlanPrompt,
  CONTEXT_PLAN_OUTPUT_SCHEMA,
} from "./context-plan";
import {
  buildIdentityResolutionPrompt,
  IDENTITY_RESOLUTION_OUTPUT_SCHEMA,
} from "./identity-resolution";

export { ANSWER_INSTRUCTIONS, PROMPT_VERSION } from "./answer";
export { CONTEXT_PLAN_OUTPUT_SCHEMA } from "./context-plan";
export { IDENTITY_RESOLUTION_OUTPUT_SCHEMA } from "./identity-resolution";

export function buildCodexPrompt(
  job: ChatbotJob,
  attachmentText: string[],
  ignoredAttachments: string[],
) {
  if (job.purpose === "context_plan") return buildContextPlanPrompt(job);
  if (job.purpose === "identity_resolution") {
    return buildIdentityResolutionPrompt(job);
  }
  return buildAnswerPrompt(job, attachmentText, ignoredAttachments);
}

export function outputSchemaForJob(job: ChatbotJob) {
  if (job.purpose === "context_plan") return CONTEXT_PLAN_OUTPUT_SCHEMA;
  if (job.purpose === "identity_resolution") {
    return IDENTITY_RESOLUTION_OUTPUT_SCHEMA;
  }
  return undefined;
}
