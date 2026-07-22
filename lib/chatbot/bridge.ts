import { randomUUID, timingSafeEqual } from "node:crypto";
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
  workflowId?: string;
  resolve: (result: MacAgentJobResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type MacAgentJobResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

export type DispatchResult =
  | { status: "offline" }
  | { status: "busy" }
  | { status: "accepted"; result: Promise<MacAgentJobResult> };

export type WorkflowLease = {
  dispatch: (job: ChatbotJob) => DispatchResult;
  release: () => void;
};

export type AcquireWorkflowResult =
  | { status: "offline" }
  | { status: "busy" }
  | { status: "accepted"; workflow: WorkflowLease };

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
  private capacity = 1;
  private pendingJobs = new Map<string, PendingJob>();
  private workflowJobs = new Map<string, string>();
  private workflowIds = new Set<string>();

  isConfigured() {
    return this.configuredSecret() !== null;
  }

  getStatus() {
    if (!this.activeSocket || !this.available) {
      return "offline" as const;
    }

    return this.usedSlots() >= this.capacity
      ? ("busy" as const)
      : ("available" as const);
  }

  handleUpgrade(request: Request, server: Server<MacAgentSocketData>) {
    if (!this.isConfigured()) {
      return new Response("本機連線服務尚未啟用", { status: 404 });
    }

    const upgraded = server.upgrade(request, {
      data: { authenticated: false },
    });

    return upgraded
      ? undefined
      : new Response("需要 WebSocket 連線", { status: 426 });
  }

  dispatch(job: ChatbotJob): DispatchResult {
    return this.dispatchJob(job);
  }

  acquireWorkflow(): AcquireWorkflowResult {
    if (!this.activeSocket || !this.available) {
      return { status: "offline" };
    }

    if (this.usedSlots() >= this.capacity) {
      return { status: "busy" };
    }

    const workflowId = randomUUID();
    this.workflowIds.add(workflowId);

    return {
      status: "accepted",
      workflow: {
        dispatch: (job) => this.dispatchJob(job, workflowId),
        release: () => {
          this.workflowIds.delete(workflowId);
        },
      },
    };
  }

  private dispatchJob(job: ChatbotJob, workflowId?: string): DispatchResult {
    if (!this.activeSocket || !this.available) {
      return { status: "offline" };
    }

    if (this.pendingJobs.has(job.id)) {
      return { status: "busy" };
    }

    if (workflowId) {
      if (
        !this.workflowIds.has(workflowId) ||
        this.workflowJobs.has(workflowId)
      ) {
        return { status: "busy" };
      }
    } else if (this.usedSlots() >= this.capacity) {
      return { status: "busy" };
    }

    const socket = this.activeSocket!;
    const result = new Promise<MacAgentJobResult>((resolve) => {
      const timer = setTimeout(() => {
        const pendingJob = this.pendingJobs.get(job.id);
        if (!pendingJob) {
          return;
        }

        this.deletePendingJob(pendingJob);
        send(socket, { type: "cancel", jobId: job.id });
        resolve({ ok: false, error: "Local Codex timed out." });
      }, CHATBOT_JOB_TIMEOUT_MS);

      const pendingJob = { id: job.id, workflowId, resolve, timer };
      this.pendingJobs.set(job.id, pendingJob);
      if (workflowId) this.workflowJobs.set(workflowId, job.id);
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
      this.capacity = Number.isFinite(message.capacity)
        ? Math.max(1, Math.min(16, Math.floor(message.capacity)))
        : 1;
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
    this.workflowIds.clear();
    this.workflowJobs.clear();
    this.clearHeartbeatTimeout();
    this.failPendingJob("The Codex worker disconnected while answering.");
  }

  private authenticate(socket: Socket, message: MacAgentClientMessage) {
    const expectedSecret = this.configuredSecret();

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
    const pendingJob = this.pendingJobs.get(message.jobId);
    if (!pendingJob) {
      return;
    }

    this.deletePendingJob(pendingJob);
    clearTimeout(pendingJob.timer);

    if (message.ok) {
      pendingJob.resolve({ ok: true, content: message.content });
      return;
    }

    pendingJob.resolve({ ok: false, error: message.error });
  }

  private failPendingJob(error: string) {
    for (const pendingJob of this.pendingJobs.values()) {
      clearTimeout(pendingJob.timer);
      pendingJob.resolve({ ok: false, error });
    }
    this.pendingJobs.clear();
    this.workflowJobs.clear();
  }

  private deletePendingJob(pendingJob: PendingJob) {
    this.pendingJobs.delete(pendingJob.id);
    if (pendingJob.workflowId) {
      this.workflowJobs.delete(pendingJob.workflowId);
    }
  }

  private usedSlots() {
    let unreservedJobs = 0;
    for (const pendingJob of this.pendingJobs.values()) {
      if (
        !pendingJob.workflowId ||
        !this.workflowIds.has(pendingJob.workflowId)
      ) {
        unreservedJobs += 1;
      }
    }
    return this.workflowIds.size + unreservedJobs;
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

  private configuredSecret() {
    const secret = process.env.MINISAGO_MAC_BRIDGE_SECRET?.trim();
    return secret && Buffer.byteLength(secret) >= 32 ? secret : null;
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
