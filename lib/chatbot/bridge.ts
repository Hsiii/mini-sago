import { timingSafeEqual } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";

import {
  CHATBOT_JOB_TIMEOUT_MS,
  CHATBOT_PROTOCOL_VERSION,
  type ChatbotJob,
  type MacAgentClientMessage,
  type MacAgentServerMessage,
} from "./protocol";

export type MacAgentSocketData = {
  authenticated: boolean;
};

type PendingJob = {
  id: string;
  resolve: (result: MacAgentJobResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

type MacAgentJobResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

export type DispatchResult =
  | { status: "offline" }
  | { status: "busy" }
  | { status: "accepted"; result: Promise<MacAgentJobResult> };

type Socket = ServerWebSocket<MacAgentSocketData>;

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function parseClientMessage(message: string | Buffer) {
  try {
    return JSON.parse(message.toString()) as MacAgentClientMessage;
  } catch {
    return null;
  }
}

function send(socket: Socket, message: MacAgentServerMessage) {
  socket.send(JSON.stringify(message));
}

export class MacAgentBridge {
  private activeSocket: Socket | null = null;
  private available = false;
  private authenticationTimers = new WeakMap<
    Socket,
    ReturnType<typeof setTimeout>
  >();
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingJob: PendingJob | null = null;

  isConfigured() {
    return Boolean(process.env.MINISAGO_MAC_BRIDGE_SECRET?.trim());
  }

  getStatus() {
    if (!this.activeSocket || !this.available) {
      return "offline" as const;
    }

    return this.pendingJob ? ("busy" as const) : ("available" as const);
  }

  handleUpgrade(request: Request, server: Server<MacAgentSocketData>) {
    if (!this.isConfigured()) {
      return new Response("Mac bridge is disabled", { status: 404 });
    }

    const upgraded = server.upgrade(request, {
      data: { authenticated: false },
    });

    return upgraded
      ? undefined
      : new Response("WebSocket upgrade required", { status: 426 });
  }

  dispatch(job: ChatbotJob): DispatchResult {
    if (this.getStatus() === "offline") {
      return { status: "offline" };
    }

    if (this.getStatus() === "busy") {
      return { status: "busy" };
    }

    const socket = this.activeSocket!;
    const result = new Promise<MacAgentJobResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingJob?.id !== job.id) {
          return;
        }

        this.pendingJob = null;
        send(socket, { type: "cancel", jobId: job.id });
        resolve({ ok: false, error: "Local Codex timed out." });
      }, CHATBOT_JOB_TIMEOUT_MS);

      this.pendingJob = { id: job.id, resolve, timer };
    });

    send(socket, { type: "job", job });
    return { status: "accepted", result };
  }

  open(socket: Socket) {
    const timer = setTimeout(() => {
      if (!socket.data.authenticated) {
        socket.close(4001, "Authentication timeout");
      }
    }, 5_000);

    this.authenticationTimers.set(socket, timer);
  }

  message(socket: Socket, rawMessage: string | Buffer) {
    const message = parseClientMessage(rawMessage);

    if (!message) {
      socket.close(4002, "Invalid message");
      return;
    }

    if (!socket.data.authenticated) {
      this.authenticate(socket, message);
      return;
    }

    if (socket !== this.activeSocket) {
      socket.close(4003, "Connection replaced");
      return;
    }

    this.armHeartbeatTimeout(socket);

    if (message.type === "heartbeat") {
      return;
    }

    if (message.type === "availability") {
      this.available = message.available;
      return;
    }

    if (message.type === "result") {
      this.finishJob(message);
      return;
    }

    socket.close(4002, "Unexpected message");
  }

  close(socket: Socket) {
    const authenticationTimer = this.authenticationTimers.get(socket);

    if (authenticationTimer) {
      clearTimeout(authenticationTimer);
      this.authenticationTimers.delete(socket);
    }

    if (socket !== this.activeSocket) {
      return;
    }

    this.activeSocket = null;
    this.available = false;
    this.clearHeartbeatTimeout();
    this.failPendingJob("The Mac disconnected while answering.");
  }

  private authenticate(socket: Socket, message: MacAgentClientMessage) {
    const expectedSecret = process.env.MINISAGO_MAC_BRIDGE_SECRET?.trim() ?? "";

    if (
      message.type !== "authenticate" ||
      message.protocolVersion !== CHATBOT_PROTOCOL_VERSION ||
      !expectedSecret ||
      !safeEqual(message.secret, expectedSecret)
    ) {
      socket.close(4001, "Authentication failed");
      return;
    }

    const oldSocket = this.activeSocket;

    if (oldSocket && oldSocket !== socket) {
      oldSocket.close(4003, "Connection replaced");
    }

    const timer = this.authenticationTimers.get(socket);
    if (timer) {
      clearTimeout(timer);
      this.authenticationTimers.delete(socket);
    }

    socket.data.authenticated = true;
    this.activeSocket = socket;
    this.available = false;
    this.armHeartbeatTimeout(socket);
    send(socket, {
      type: "authenticated",
      protocolVersion: CHATBOT_PROTOCOL_VERSION,
    });
  }

  private finishJob(
    message: Extract<MacAgentClientMessage, { type: "result" }>,
  ) {
    if (!this.pendingJob || this.pendingJob.id !== message.jobId) {
      return;
    }

    const pendingJob = this.pendingJob;
    this.pendingJob = null;
    clearTimeout(pendingJob.timer);

    if (message.ok) {
      pendingJob.resolve({ ok: true, content: message.content });
      return;
    }

    pendingJob.resolve({ ok: false, error: message.error });
  }

  private failPendingJob(error: string) {
    if (!this.pendingJob) {
      return;
    }

    const pendingJob = this.pendingJob;
    this.pendingJob = null;
    clearTimeout(pendingJob.timer);
    pendingJob.resolve({ ok: false, error });
  }

  private armHeartbeatTimeout(socket: Socket) {
    this.clearHeartbeatTimeout();
    this.heartbeatTimer = setTimeout(() => {
      if (socket === this.activeSocket) {
        socket.close(4004, "Heartbeat timeout");
      }
    }, 45_000);
  }

  private clearHeartbeatTimeout() {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}

export const macAgentBridge = new MacAgentBridge();

export const macAgentWebSocketHandler = {
  open(socket: Socket) {
    macAgentBridge.open(socket);
  },
  message(socket: Socket, message: string | Buffer) {
    macAgentBridge.message(socket, message);
  },
  close(socket: Socket) {
    macAgentBridge.close(socket);
  },
};
