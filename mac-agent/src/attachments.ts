import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import type { ChatbotAttachment, ChatbotJob } from "../../lib/chatbot/protocol";

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 100_000;
const DOWNLOAD_TIMEOUT_MS = 20_000;

const textContentTypes = new Set([
  "application/json",
  "application/ld+json",
  "application/javascript",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
]);

const textExtensions = new Set([
  ".csv",
  ".json",
  ".md",
  ".rtf",
  ".tsv",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const imageContentTypes = new Set(["image/jpeg", "image/png"]);

type AttachmentCandidate = {
  attachment: ChatbotAttachment;
  surroundingText: string;
  order: number;
};

export type PreparedAttachments = {
  directory: string;
  imagePaths: string[];
  textBlocks: string[];
  ignored: string[];
  cleanup: () => Promise<void>;
};

function queryTokens(query: string) {
  return query
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2);
}

function isSupported(attachment: ChatbotAttachment) {
  const contentType = attachment.contentType?.toLocaleLowerCase() ?? "";
  const extension = extname(attachment.filename).toLocaleLowerCase();

  return (
    imageContentTypes.has(contentType) ||
    contentType === "application/pdf" ||
    contentType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    contentType.startsWith("text/") ||
    textContentTypes.has(contentType) ||
    textExtensions.has(extension) ||
    extension === ".pdf" ||
    extension === ".docx"
  );
}

function rankCandidates(job: ChatbotJob) {
  const tokens = queryTokens(job.request);
  const candidates: AttachmentCandidate[] = [];

  for (const [messageIndex, message] of job.messages.entries()) {
    for (const item of message.attachments) {
      candidates.push({
        attachment: item,
        surroundingText:
          `${message.content} ${item.filename}`.toLocaleLowerCase(),
        order: messageIndex,
      });
    }
  }

  return candidates
    .filter(({ attachment }) => isSupported(attachment))
    .sort((left, right) => {
      const score = (candidate: AttachmentCandidate) =>
        tokens.reduce(
          (total, token) =>
            total + (candidate.surroundingText.includes(token) ? 1 : 0),
          0,
        );

      return score(right) - score(left) || right.order - left.order;
    })
    .slice(0, MAX_ATTACHMENTS);
}

async function download(url: string) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`download returned ${response.status}`);
  }

  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_ATTACHMENT_BYTES) {
    throw new Error("attachment exceeds 20 MB");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    size += value.byteLength;
    if (size > MAX_ATTACHMENT_BYTES) {
      await reader.cancel();
      throw new Error("attachment exceeds 20 MB");
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function truncate(value: string) {
  return value.slice(0, MAX_EXTRACTED_CHARACTERS);
}

async function extractPdf(bytes: Uint8Array) {
  const document = await getDocument({
    data: bytes,
    useWorkerFetch: false,
  }).promise;
  const pages: string[] = [];
  let characterCount = 0;

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");

    pages.push(`[Page ${pageNumber}] ${text}`);
    characterCount += text.length;
    if (characterCount >= MAX_EXTRACTED_CHARACTERS) {
      break;
    }
  }

  return truncate(pages.join("\n"));
}

async function extractText(attachment: ChatbotAttachment, bytes: Uint8Array) {
  const contentType = attachment.contentType?.toLocaleLowerCase() ?? "";
  const extension = extname(attachment.filename).toLocaleLowerCase();

  if (contentType === "application/pdf" || extension === ".pdf") {
    return extractPdf(bytes);
  }

  if (
    contentType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    extension === ".docx"
  ) {
    const result = await mammoth.extractRawText({
      buffer: Buffer.from(bytes),
    });
    return truncate(result.value);
  }

  return truncate(new TextDecoder().decode(bytes));
}

function safeFilename(index: number, filename: string) {
  const name = basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${index}-${name || "attachment"}`;
}

export async function prepareAttachments(
  job: ChatbotJob,
): Promise<PreparedAttachments> {
  const directory = await mkdtemp(join(tmpdir(), "minisago-chatbot-"));
  const imagePaths: string[] = [];
  const textBlocks: string[] = [];
  const ignored: string[] = [];
  const candidates = rankCandidates(job);

  for (const [index, candidate] of candidates.entries()) {
    const { attachment } = candidate;

    if (attachment.size > MAX_ATTACHMENT_BYTES) {
      ignored.push(`${attachment.filename}: exceeds 20 MB`);
      continue;
    }

    try {
      const bytes = await download(attachment.url);
      const contentType = attachment.contentType?.toLocaleLowerCase() ?? "";

      if (imageContentTypes.has(contentType)) {
        const path = join(directory, safeFilename(index, attachment.filename));
        await Bun.write(path, bytes);
        imagePaths.push(path);
        continue;
      }

      const text = await extractText(attachment, bytes);
      textBlocks.push(`Attachment: ${attachment.filename}\n${text}`);
    } catch (error) {
      ignored.push(
        `${attachment.filename}: ${error instanceof Error ? error.message : "could not analyze"}`,
      );
    }
  }

  return {
    directory,
    imagePaths,
    textBlocks,
    ignored,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export const attachmentLimits = {
  count: MAX_ATTACHMENTS,
  bytes: MAX_ATTACHMENT_BYTES,
};
