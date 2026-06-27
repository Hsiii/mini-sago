import { getPublicDiscordSummary } from "../lib/discord/env";
import { startInstagramGateway } from "../lib/discord/instagram-gateway";
import { handleDiscordInteractionRequest } from "../lib/discord/interactions";
import { startToeflVocabScheduler } from "../lib/discord/toefl-vocab";

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
      },
      roleCount: summary.roleCount,
    });
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
}

function handleRequest(request: Request) {
  const { pathname } = new URL(request.url);

  if (request.method === "GET" && pathname === "/api/health") {
    return buildHealthResponse();
  }

  if (request.method === "POST" && pathname === "/api/interactions") {
    return handleDiscordInteractionRequest(request);
  }

  return new Response("Not found", { status: 404 });
}

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME || "0.0.0.0";
const server = Bun.serve({
  port,
  hostname,
  fetch: handleRequest,
});

if (process.env.DISCORD_GATEWAY_DISABLED !== "true") {
  startInstagramGateway();
}

startToeflVocabScheduler();

console.log(`WM31Bot listening on http://${server.hostname}:${server.port}`);
