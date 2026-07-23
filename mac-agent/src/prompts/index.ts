import type { ChatbotJob } from "../../../lib/chatbot/protocol";
import { ANSWER_OUTPUT_SCHEMA, buildAnswerPrompt } from "./answer";
import {
  buildContextPlanPrompt,
  CONTEXT_PLAN_OUTPUT_SCHEMA,
} from "./context-plan";
import {
  buildExecutionRoutePrompt,
  EXECUTION_ROUTE_OUTPUT_SCHEMA,
} from "./execution-route";
import {
  buildSocialActionPrompt,
  SOCIAL_ACTION_OUTPUT_SCHEMA,
} from "./social-action";

export {
  ANSWER_INSTRUCTIONS,
  ANSWER_OUTPUT_SCHEMA,
  PROMPT_VERSION,
} from "./answer";
export { CONTEXT_PLAN_OUTPUT_SCHEMA } from "./context-plan";
export { EXECUTION_ROUTE_OUTPUT_SCHEMA } from "./execution-route";
export { SOCIAL_ACTION_OUTPUT_SCHEMA } from "./social-action";

export function buildCodexPrompt(
  job: ChatbotJob,
  attachmentText: string[],
  ignoredAttachments: string[],
  developerPolicy?: string,
) {
  if (job.purpose === "execution_route") {
    return buildExecutionRoutePrompt(job);
  }
  if (job.purpose === "context_plan") return buildContextPlanPrompt(job);
  if (job.purpose === "social_action") return buildSocialActionPrompt(job);
  return buildAnswerPrompt(
    job,
    attachmentText,
    ignoredAttachments,
    developerPolicy,
  );
}

export function outputSchemaForJob(job: ChatbotJob) {
  if (job.purpose === "execution_route") return EXECUTION_ROUTE_OUTPUT_SCHEMA;
  if (job.purpose === "context_plan") return CONTEXT_PLAN_OUTPUT_SCHEMA;
  if (job.purpose === "social_action") return SOCIAL_ACTION_OUTPUT_SCHEMA;
  if (job.purpose === "answer") return ANSWER_OUTPUT_SCHEMA;
  return undefined;
}
