import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";

import { MacAgentBridge, type MacAgentSocketData } from "./bridge";
import { CHATBOT_PROTOCOL_VERSION, type ChatbotJob } from "./protocol";

const originalSecret = process.env.MINISAGO_MAC_BRIDGE_SECRET;

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.MINISAGO_MAC_BRIDGE_SECRET;
    return;
  }

  process.env.MINISAGO_MAC_BRIDGE_SECRET = originalSecret;
});

function fakeSocket() {
  const sent: string[] = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  const socket = {
    data: { authenticated: false },
    send(message: string) {
      sent.push(message);
    },
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
    },
  } as unknown as ServerWebSocket<MacAgentSocketData>;

  return { socket, sent, closed };
}

describe("Mac agent bridge", () => {
  test("stays offline until an authenticated helper reports availability", () => {
    process.env.MINISAGO_MAC_BRIDGE_SECRET = "bridge-secret";
    const bridge = new MacAgentBridge();
    const { socket, sent } = fakeSocket();

    bridge.open(socket);
    bridge.message(
      socket,
      JSON.stringify({
        type: "authenticate",
        protocolVersion: CHATBOT_PROTOCOL_VERSION,
        secret: "bridge-secret",
      }),
    );

    expect(sent.map((message) => JSON.parse(message))).toEqual([
      { type: "authenticated", protocolVersion: CHATBOT_PROTOCOL_VERSION },
    ]);
    expect(bridge.getStatus()).toBe("offline");

    bridge.message(
      socket,
      JSON.stringify({ type: "availability", available: true }),
    );
    expect(bridge.getStatus()).toBe("available");
  });

  test("runs one job at a time and resolves its matching result", async () => {
    process.env.MINISAGO_MAC_BRIDGE_SECRET = "bridge-secret";
    const bridge = new MacAgentBridge();
    const { socket, sent } = fakeSocket();
    const job: ChatbotJob = {
      id: "job-1",
      channelId: "channel-1",
      requestMessageId: "message-1",
      request: "Summarize this",
      messages: [],
    };

    bridge.open(socket);
    bridge.message(
      socket,
      JSON.stringify({
        type: "authenticate",
        protocolVersion: CHATBOT_PROTOCOL_VERSION,
        secret: "bridge-secret",
      }),
    );
    bridge.message(
      socket,
      JSON.stringify({ type: "availability", available: true }),
    );

    const dispatch = bridge.dispatch(job);
    expect(dispatch.status).toBe("accepted");
    expect(bridge.dispatch({ ...job, id: "job-2" }).status).toBe("busy");
    expect(JSON.parse(sent.at(-1)!)).toEqual({ type: "job", job });

    bridge.message(
      socket,
      JSON.stringify({
        type: "result",
        jobId: job.id,
        ok: true,
        content: "A short summary",
      }),
    );

    if (dispatch.status !== "accepted") {
      throw new Error("Expected accepted dispatch");
    }

    expect(await dispatch.result).toEqual({
      ok: true,
      content: "A short summary",
    });
    expect(bridge.getStatus()).toBe("available");
  });
});
