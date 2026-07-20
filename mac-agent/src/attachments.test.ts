import { access } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import type { ChatbotJob } from "../../lib/chatbot/protocol";
import { attachmentLimits, prepareAttachments } from "./attachments";

describe("chatbot attachment limits", () => {
  test("caps downloads at ten files and twenty megabytes each", () => {
    expect(attachmentLimits).toEqual({
      count: 10,
      bytes: 20 * 1024 * 1024,
    });
  });

  test.serial(
    "extracts text attachments and removes temporary files",
    async () => {
      const originalFetch = globalThis.fetch;
      const job: ChatbotJob = {
        id: "job-1",
        channelId: "channel-1",
        requestMessageId: "message-2",
        request: "What is in the notes?",
        messages: [
          {
            id: "message-1",
            author: "Hsi",
            timestamp: "2026-07-20T10:00:00.000Z",
            content: "Here are the notes",
            attachments: [
              {
                id: "attachment-1",
                filename: "notes.txt",
                contentType: "text/plain",
                size: 19,
                url: "https://cdn.discordapp.com/notes.txt",
              },
            ],
          },
        ],
        searchResults: [
          {
            id: "message-search-1",
            author: "Daniel",
            timestamp: "2026-06-01T10:00:00.000Z",
            content: "Earlier search match",
            attachments: [
              {
                id: "attachment-search-1",
                filename: "meme.png",
                contentType: "image/png",
                size: 17,
                url: "https://cdn.discordapp.com/meme.png",
              },
            ],
            jumpUrl:
              "https://discord.com/channels/guild-1/channel-1/message-search-1",
          },
        ],
      };

      globalThis.fetch = (async () =>
        new Response("Ship next Friday.", {
          headers: { "Content-Length": "17" },
        })) as unknown as typeof fetch;

      try {
        const prepared = await prepareAttachments(job);
        expect(prepared.textBlocks).toEqual([
          "Attachment: notes.txt\nShip next Friday.",
        ]);
        expect(prepared.imagePaths).toHaveLength(1);
        expect(prepared.ignored).toEqual([]);
        await prepared.cleanup();
        expect(access(prepared.directory)).rejects.toThrow();
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});
