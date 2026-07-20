import type { ChatbotJob } from "../../../lib/chatbot/protocol";

function block(name: string, value: unknown) {
  const content = typeof value === "string" ? value : JSON.stringify(value);
  return `<${name}>\n${content}\n</${name}>`;
}

export function requestContext(job: ChatbotJob) {
  return [
    block("current_request", job.request),
    block("discord_messages_json", job.messages),
  ].join("\n\n");
}

export function answerContext(
  job: ChatbotJob,
  attachmentText: string[],
  ignoredAttachments: string[],
) {
  const sections = [requestContext(job)];

  if (job.searchStatus && job.searchStatus !== "not_requested") {
    sections.push(
      block("discord_search_status", job.searchStatus),
      block("discord_search_results_json", job.searchResults ?? []),
    );
  }

  if (attachmentText.length > 0) {
    sections.push(block("extracted_attachments", attachmentText.join("\n\n")));
  }

  if (ignoredAttachments.length > 0) {
    sections.push(block("ignored_attachments", ignoredAttachments.join("\n")));
  }

  return sections.join("\n\n");
}
