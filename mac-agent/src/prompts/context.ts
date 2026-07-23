import type { ChatbotJob, ChatbotMessage } from "../../../lib/chatbot/protocol";

function block(name: string, value: unknown) {
  const content = typeof value === "string" ? value : JSON.stringify(value);
  return `<${name}>\n${content}\n</${name}>`;
}

function promptAttachment({
  filename,
  contentType,
}: ChatbotMessage["attachments"][number]) {
  return {
    filename,
    ...(contentType ? { contentType } : {}),
  };
}

function promptMessage(message: ChatbotMessage): Record<string, unknown> {
  return {
    ...(message.role ? { role: message.role } : {}),
    author: message.author,
    ...(message.authorAliases?.length
      ? { authorAliases: message.authorAliases }
      : {}),
    timestamp: message.timestamp,
    content: message.content,
    ...(message.attachments.length > 0
      ? { attachments: message.attachments.map(promptAttachment) }
      : {}),
    ...(message.reactions?.length ? { reactions: message.reactions } : {}),
    ...(message.channelName ? { channelName: message.channelName } : {}),
    ...(message.jumpUrl ? { jumpUrl: message.jumpUrl } : {}),
    ...(message.referencedMessage
      ? { referencedMessage: promptMessage(message.referencedMessage) }
      : {}),
  };
}

function requestMessageContext(job: ChatbotJob) {
  const message = job.requestMessage;
  if (
    !message ||
    (!message.attachments.length &&
      !message.reactions?.length &&
      !message.referencedMessage)
  ) {
    return undefined;
  }

  return {
    author: message.author,
    ...(message.authorAliases?.length
      ? { authorAliases: message.authorAliases }
      : {}),
    timestamp: message.timestamp,
    ...(message.attachments.length > 0
      ? { attachments: message.attachments.map(promptAttachment) }
      : {}),
    ...(message.reactions?.length ? { reactions: message.reactions } : {}),
    ...(message.referencedMessage
      ? { referencedMessage: promptMessage(message.referencedMessage) }
      : {}),
  };
}

export function requestContext(
  job: ChatbotJob,
  messageBlock = "discord_messages_json",
) {
  const sections = [block("current_request", job.request)];
  const currentMessage = requestMessageContext(job);

  if (currentMessage) {
    sections.push(block("current_message_context_json", currentMessage));
  }

  sections.push(block(messageBlock, job.messages.map(promptMessage)));
  return sections.join("\n\n");
}

export function answerContext(
  job: ChatbotJob,
  attachmentText: string[],
  ignoredAttachments: string[],
) {
  const sections = [requestContext(job)];

  if (job.memberLookupStatus && job.memberLookupStatus !== "not_requested") {
    sections.push(
      block("discord_member_lookup_status", job.memberLookupStatus),
      block("discord_member_results_json", job.memberResults ?? []),
    );
  }

  if (job.searchStatus && job.searchStatus !== "not_requested") {
    sections.push(
      block("discord_search_status", job.searchStatus),
      block(
        "discord_search_results_json",
        (job.searchResults ?? []).map((message, sourceIndex) => ({
          sourceIndex,
          ...promptMessage(message),
        })),
      ),
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
