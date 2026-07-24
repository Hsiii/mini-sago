import { afterEach, describe, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { handleChatbotMcpRequest, registerChatbotMcpSession } from "./mcp";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function startServer() {
  const server = Bun.serve({
    port: 0,
    fetch: handleChatbotMcpRequest,
  });
  servers.push(server);
  return `http://${server.hostname}:${server.port}`;
}

function handlers() {
  return {
    getRecentMessages: async (limit: number) => [
      {
        id: `recent-${limit}`,
        author: "Daniel",
        timestamp: "2026-07-24T10:00:00.000Z",
        content: "recent context",
        attachments: [
          {
            id: "attachment-1",
            filename: "notes.txt",
            contentType: "text/plain",
            size: 42,
            url: "https://cdn.discordapp.com/private/notes.txt",
          },
        ],
      },
    ],
    searchMessages: async () => [
      {
        id: "search-1",
        author: "Hsi",
        timestamp: "2026-07-20T10:00:00.000Z",
        content: "older result",
        attachments: [],
        channelName: "projects",
        jumpUrl: "https://discord.com/channels/guild-1/channel-1/search-1",
      },
    ],
    lookupMembers: async (queries: string[]) =>
      queries.map((query) => ({ query, names: [query, "Display Name"] })),
    getPreviousTrace: async () => ({
      status: "not_found" as const,
    }),
    resolveContext: async () => ({
      history: { status: "complete" as const, messages: [] },
      search: { status: "not_requested" as const, results: [] },
      members: { status: "not_requested" as const, results: [] },
      previousTrace: { status: "not_requested" as const },
    }),
    addReaction: async (emoji: string) => emoji === "👍",
    addReactionDescription:
      'React to the current request. Custom values: {"sago":"sago:1"}',
  };
}

async function connect(token: string) {
  const client = new Client({
    name: "minisago-test",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${startServer()}/api/chatbot/mcp`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  );
  await client.connect(transport);
  return client;
}

describe("MiniSago MCP server", () => {
  test("requires an active bearer-bound chatbot session", async () => {
    const response = await fetch(`${startServer()}/api/chatbot/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer invalid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("exposes bounded tools and strips Discord CDN URLs", async () => {
    const session = registerChatbotMcpSession(handlers());
    const client = await connect(session.token);
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "get_recent_messages",
      "search_messages",
      "lookup_members",
      "get_previous_trace",
      "resolve_context",
      "add_reaction",
    ]);
    expect(
      tools.tools.find((tool) => tool.name === "add_reaction")?.description,
    ).toContain("sago:1");

    const result = await client.callTool({
      name: "get_recent_messages",
      arguments: { limit: 40 },
    });
    expect(result.structuredContent).toMatchObject({
      status: "complete",
      messages: [{ id: "recent-40" }],
    });
    expect(JSON.stringify(result)).not.toContain("cdn.discordapp.com");

    await client.close();
    session.revoke();
  });

  test("validates tool arguments and records only successful reactions", async () => {
    const session = registerChatbotMcpSession(handlers());
    const client = await connect(session.token);

    const invalid = await client.callTool({
      name: "get_recent_messages",
      arguments: { limit: 101 },
    });
    expect(invalid.isError).toBe(true);

    await client.callTool({
      name: "add_reaction",
      arguments: { emoji: "👎" },
    });
    expect(session.snapshot().reacted).toBe(false);

    await client.callTool({
      name: "add_reaction",
      arguments: { emoji: "👍" },
    });
    expect(session.snapshot().reacted).toBe(true);

    await client.close();
    session.revoke();
  });

  test("hides guild tools when no guild-scoped handlers exist", async () => {
    const baseHandlers = handlers();
    const session = registerChatbotMcpSession({
      getRecentMessages: baseHandlers.getRecentMessages,
      getPreviousTrace: baseHandlers.getPreviousTrace,
      resolveContext: baseHandlers.resolveContext,
    });
    const client = await connect(session.token);
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "get_recent_messages",
      "get_previous_trace",
      "resolve_context",
    ]);

    await client.close();
    session.revoke();
  });
});
