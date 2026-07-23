import type { ChatbotJob } from "../../../lib/chatbot/protocol";
import { buildAnswerPrompt } from "./answer";
import {
  buildContextPlanPrompt,
  CONTEXT_PLAN_OUTPUT_SCHEMA,
} from "./context-plan";
import {
  buildExecutionRoutePrompt,
  EXECUTION_ROUTE_OUTPUT_SCHEMA,
} from "./execution-route";

export { ANSWER_INSTRUCTIONS, PROMPT_VERSION } from "./answer";
export { CONTEXT_PLAN_OUTPUT_SCHEMA } from "./context-plan";
export { EXECUTION_ROUTE_OUTPUT_SCHEMA } from "./execution-route";

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
  return undefined;
}
