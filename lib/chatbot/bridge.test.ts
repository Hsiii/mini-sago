import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";

import { MacAgentBridge, type MacAgentSocketData } from "./bridge";
import { CHATBOT_PROTOCOL_VERSION, type ChatbotJob } from "./protocol";

const originalSecret = process.env.MINISAGO_MAC_BRIDGE_SECRET;
const bridgeSecret = "bridge-secret-that-is-at-least-32-bytes";

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
    process.env.MINISAGO_MAC_BRIDGE_SECRET = bridgeSecret;
    const bridge = new MacAgentBridge();
    const { socket, sent } = fakeSocket();

    bridge.open(socket);
    bridge.message(
      socket,
      JSON.stringify({
        type: "authenticate",
        protocolVersion: CHATBOT_PROTOCOL_VERSION,
        secret: bridgeSecret,
        workerId: "oracle",
        capabilities: ["chat", "dev"],
        priority: 100,
      }),
    );

    expect(sent.map((message) => JSON.parse(message))).toEqual([
      { type: "authenticated", protocolVersion: CHATBOT_PROTOCOL_VERSION },
    ]);
    expect(bridge.getStatus()).toBe("offline");

    bridge.message(
      socket,
      JSON.stringify({ type: "availability", available: true, capacity: 1 }),
    );
    expect(bridge.getStatus()).toBe("available");
  });

  test("enforces the advertised capacity and resolves matching results", async () => {
    process.env.MINISAGO_MAC_BRIDGE_SECRET = bridgeSecret;
    const bridge = new MacAgentBridge();
    const { socket, sent } = fakeSocket();
    const job: ChatbotJob = {
      id: "job-1",
      requesterUserId: "test-user",
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
        secret: bridgeSecret,
        workerId: "oracle",
        capabilities: ["chat", "dev"],
        priority: 100,
      }),
    );
    bridge.message(
      socket,
      JSON.stringify({ type: "availability", available: true, capacity: 1 }),
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

  test("reserves the bridge across planning and answering jobs", async () => {
    process.env.MINISAGO_MAC_BRIDGE_SECRET = bridgeSecret;
    const bridge = new MacAgentBridge();
    const { socket } = fakeSocket();
    const job: ChatbotJob = {
      id: "planner-1",
      requesterUserId: "test-user",
      purpose: "context_plan",
      channelId: "channel-1",
      requestMessageId: "message-1",
      request: "What did we decide?",
      messages: [],
    };

    bridge.open(socket);
    bridge.message(
      socket,
      JSON.stringify({
        type: "authenticate",
        protocolVersion: CHATBOT_PROTOCOL_VERSION,
        secret: bridgeSecret,
        workerId: "oracle",
        capabilities: ["chat", "dev"],
        priority: 100,
      }),
    );
    bridge.message(
      socket,
      JSON.stringify({ type: "availability", available: true, capacity: 1 }),
    );

    const acquired = bridge.acquireWorkflow();
    expect(acquired.status).toBe("accepted");
    expect(bridge.getStatus()).toBe("busy");
    expect(bridge.acquireWorkflow().status).toBe("busy");
    if (acquired.status !== "accepted") throw new Error("Expected workflow");

    const planning = acquired.workflow.dispatch(job);
    expect(planning.status).toBe("accepted");
    bridge.message(
      socket,
      JSON.stringify({
        type: "result",
        jobId: job.id,
        ok: true,
        content: '{"history":"local","queries":[]}',
      }),
    );
    if (planning.status !== "accepted") throw new Error("Expected planning");
    await planning.result;

    const answer = acquired.workflow.dispatch({
      ...job,
      id: "answer-1",
      purpose: "answer",
    });
    expect(answer.status).toBe("accepted");
    acquired.workflow.release();
    expect(bridge.getStatus()).toBe("busy");
    bridge.message(
      socket,
      JSON.stringify({
        type: "result",
        jobId: "answer-1",
        ok: true,
        content: "Friday",
      }),
    );
    if (answer.status !== "accepted") throw new Error("Expected answer");
    await answer.result;
    expect(bridge.getStatus()).toBe("available");
  });

  test("runs multiple reserved workflows concurrently up to capacity", async () => {
    process.env.MINISAGO_MAC_BRIDGE_SECRET = bridgeSecret;
    const bridge = new MacAgentBridge();
    const { socket } = fakeSocket();
    const job: ChatbotJob = {
      id: "job-1",
      requesterUserId: "test-user",
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
        secret: bridgeSecret,
        workerId: "oracle",
        capabilities: ["chat", "dev"],
        priority: 100,
      }),
    );
    bridge.message(
      socket,
      JSON.stringify({ type: "availability", available: true, capacity: 2 }),
    );

    const first = bridge.acquireWorkflow();
    const second = bridge.acquireWorkflow();
    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    expect(bridge.acquireWorkflow().status).toBe("busy");
    if (first.status !== "accepted" || second.status !== "accepted") {
      throw new Error("Expected concurrent workflows");
    }

    const firstJob = first.workflow.dispatch(job);
    const secondJob = second.workflow.dispatch({ ...job, id: "job-2" });
    expect(firstJob.status).toBe("accepted");
    expect(secondJob.status).toBe("accepted");

    bridge.message(
      socket,
      JSON.stringify({
        type: "result",
        jobId: "job-2",
        ok: true,
        content: "second",
      }),
    );
    bridge.message(
      socket,
      JSON.stringify({
        type: "result",
        jobId: "job-1",
        ok: true,
        content: "first",
      }),
    );

    if (firstJob.status !== "accepted" || secondJob.status !== "accepted") {
      throw new Error("Expected concurrent jobs");
    }
    expect(await Promise.all([firstJob.result, secondJob.result])).toEqual([
      { ok: true, content: "first" },
      { ok: true, content: "second" },
    ]);
    first.workflow.release();
    second.workflow.release();
    expect(bridge.getStatus()).toBe("available");
  });

  test("keeps cloud and Mac connected while routing workflows by capability", async () => {
    process.env.MINISAGO_MAC_BRIDGE_SECRET = bridgeSecret;
    const bridge = new MacAgentBridge();
    const cloud = fakeSocket();
    const mac = fakeSocket();
    const authenticate = (
      target: ReturnType<typeof fakeSocket>,
      workerId: string,
      capabilities: Array<"chat" | "dev" | "mac">,
      priority: number,
    ) => {
      bridge.open(target.socket);
      bridge.message(
        target.socket,
        JSON.stringify({
          type: "authenticate",
          protocolVersion: CHATBOT_PROTOCOL_VERSION,
          secret: bridgeSecret,
          workerId,
          capabilities,
          priority,
        }),
      );
      bridge.message(
        target.socket,
        JSON.stringify({ type: "availability", available: true, capacity: 1 }),
      );
    };

    authenticate(cloud, "oracle", ["chat", "dev"], 100);
    authenticate(mac, "hsi-mac", ["chat", "dev", "mac"], 50);
    expect(cloud.closed).toEqual([]);
    expect(mac.closed).toEqual([]);
    expect(bridge.getWorkerSummary()).toEqual({
      connected: 2,
      available: 2,
      capacity: 2,
      active: 0,
    });

    const first = bridge.acquireWorkflow();
    const fallback = bridge.acquireWorkflow();
    if (first.status !== "accepted" || fallback.status !== "accepted") {
      throw new Error("Expected both workers to accept workflows");
    }
    const cloudJob: ChatbotJob = {
      id: "cloud-job",
      requesterUserId: "owner",
      channelId: "channel-1",
      requestMessageId: "message-1",
      request: "Review a PR",
      messages: [],
    };
    const macJob = { ...cloudJob, id: "mac-job", request: "Open Xcode" };
    const cloudDispatch = first.workflow.dispatch(cloudJob);
    const fallbackDispatch = fallback.workflow.dispatch(macJob);
    expect(JSON.parse(cloud.sent.at(-1)!)).toEqual({
      type: "job",
      job: cloudJob,
    });
    expect(JSON.parse(mac.sent.at(-1)!)).toEqual({
      type: "job",
      job: macJob,
    });
    bridge.message(
      mac.socket,
      JSON.stringify({
        type: "result",
        jobId: "cloud-job",
        ok: true,
        content: "wrong worker",
      }),
    );
    expect(bridge.getWorkerSummary().active).toBe(2);
    bridge.message(
      cloud.socket,
      JSON.stringify({
        type: "result",
        jobId: "cloud-job",
        ok: true,
        content: "routed",
      }),
    );
    bridge.message(
      mac.socket,
      JSON.stringify({
        type: "result",
        jobId: "mac-job",
        ok: true,
        content: "fallback",
      }),
    );
    if (
      cloudDispatch.status !== "accepted" ||
      fallbackDispatch.status !== "accepted"
    ) {
      throw new Error("Expected routed jobs");
    }
    await Promise.all([cloudDispatch.result, fallbackDispatch.result]);
    fallback.workflow.release();

    expect(first.workflow.route(["dev", "mac"])).toEqual({
      status: "accepted",
    });
    const localDispatch = first.workflow.dispatch({
      ...macJob,
      id: "local-job",
    });
    expect(JSON.parse(mac.sent.at(-1)!)).toEqual({
      type: "job",
      job: { ...macJob, id: "local-job" },
    });
    bridge.message(
      mac.socket,
      JSON.stringify({
        type: "result",
        jobId: "local-job",
        ok: true,
        content: "local",
      }),
    );
    if (localDispatch.status !== "accepted") {
      throw new Error("Expected Mac-routed job");
    }
    expect(await localDispatch.result).toEqual({ ok: true, content: "local" });
    first.workflow.release();
  });
});
