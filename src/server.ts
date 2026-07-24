import type { Server } from "bun";

import { getChatbotAccessConfig } from "../lib/chatbot/access";
import { getPublicDiscordSummary } from "../lib/discord/env";
import {
  macAgentBridge,
  macAgentWebSocketHandler,
  type MacAgentSocketData,
} from "../lib/chatbot/bridge";
import { handleChatbotMcpRequest } from "../lib/chatbot/mcp";
import { startGamerForumMonitor } from "../lib/discord/gamer-forum-monitor";
import { startInstagramGateway } from "../lib/discord/instagram-gateway";
import {
  handleGithubWebhookRequest,
  isGithubWebhookConfigured,
} from "../lib/discord/github-pr-webhook";
import { handleDiscordInteractionRequest } from "../lib/discord/interactions";
import { startToeflVocabScheduler } from "../lib/discord/toefl-vocab";
import { startXPostMonitor } from "../lib/discord/x-post-monitor";

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function buildHealthResponse() {
  try {
    const summary = getPublicDiscordSummary();

    return jsonResponse({
      ok: true,
      configured: {
        applicationId: summary.hasApplicationId,
        publicKey: summary.hasPublicKey,
        botToken: summary.hasBotToken,
        guildId: summary.hasGuildId,
        githubWebhook: isGithubWebhookConfigured(),
        macBridge: macAgentBridge.isConfigured(),
      },
      workers: macAgentBridge.getWorkerSummary(),
      roleCount: summary.roleCount,
    });
  } catch (error) {
    console.error("Invalid health check configuration:", error);
    return jsonResponse(
      {
        ok: false,
        error: "服務設定無效",
      },
      500,
    );
  }
}

function handleRequest(request: Request, server: Server<MacAgentSocketData>) {
  const { pathname } = new URL(request.url);

  if (request.method === "GET" && pathname === "/api/mac-agent/ws") {
    return macAgentBridge.handleUpgrade(request, server);
  }

  if (request.method === "GET" && pathname === "/api/health") {
    return buildHealthResponse();
  }

  if (pathname === "/api/chatbot/mcp") {
    return handleChatbotMcpRequest(request);
  }

  if (request.method === "POST" && pathname === "/api/interactions") {
    return handleDiscordInteractionRequest(request);
  }

  if (request.method === "POST" && pathname === "/api/github/webhook") {
    return handleGithubWebhookRequest(request);
  }

  return new Response("找不到此頁面", { status: 404 });
}

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME || "0.0.0.0";
getChatbotAccessConfig();
const server = Bun.serve({
  port,
  hostname,
  fetch: handleRequest,
  websocket: macAgentWebSocketHandler,
});

if (process.env.DISCORD_GATEWAY_DISABLED !== "true") {
  startInstagramGateway();
}

startToeflVocabScheduler();
startGamerForumMonitor();
startXPostMonitor();

console.log(`MiniSago listening on http://${server.hostname}:${server.port}`);
