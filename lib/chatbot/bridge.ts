import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";

import {
  CHATBOT_JOB_TIMEOUT_MS,
  CHATBOT_DEV_JOB_TIMEOUT_MS,
  CHATBOT_PROTOCOL_VERSION,
  CHATBOT_WORKER_CAPABILITIES,
  type ChatbotJob,
  type ChatbotWorkerCapability,
  type MacAgentClientMessage,
  type MacAgentServerMessage,
} from "./protocol";

export type MacAgentSocketData = {
  authenticated: boolean;
  workerId?: string;
};

type PendingJob = {
  id: string;
  workerId: string;
  workflowId?: string;
  resolve: (result: MacAgentJobResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Worker = {
  id: string;
  socket: Socket;
  capabilities: Set<ChatbotWorkerCapability>;
  priority: number;
  available: boolean;
  capacity: number;
};

type Workflow = {
  workerId: string;
  activeJobId?: string;
};

export type MacAgentJobResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

export type DispatchResult =
  | { status: "offline" }
  | { status: "busy" }
  | { status: "accepted"; result: Promise<MacAgentJobResult> };

export type WorkerSelectionResult =
  | { status: "offline" }
  | { status: "busy" }
  | { status: "accepted" };

export type WorkflowLease = {
  dispatch: (job: ChatbotJob) => DispatchResult;
  route: (capabilities: ChatbotWorkerCapability[]) => WorkerSelectionResult;
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

function validCapabilities(
  capabilities: unknown,
): capabilities is ChatbotWorkerCapability[] {
  return (
    Array.isArray(capabilities) &&
    capabilities.length > 0 &&
    capabilities.every(
      (capability) =>
        typeof capability === "string" &&
        CHATBOT_WORKER_CAPABILITIES.includes(
          capability as ChatbotWorkerCapability,
        ),
    )
  );
}

export class MacAgentBridge {
  private workers = new Map<string, Worker>();
  private authenticationTimers = new WeakMap<
    Socket,
    ReturnType<typeof setTimeout>
  >();
  private heartbeatTimers = new WeakMap<
    Socket,
    ReturnType<typeof setTimeout>
  >();
  private pendingJobs = new Map<string, PendingJob>();
  private workflows = new Map<string, Workflow>();

  isConfigured() {
    return this.configuredSecret() !== null;
  }

  getStatus(capabilities: ChatbotWorkerCapability[] = ["chat"]) {
    const status = this.selectWorker(capabilities).status;
    return status === "accepted" ? ("available" as const) : status;
  }

  getWorkerSummary() {
    const workers = [...this.workers.values()];
    return {
      connected: workers.length,
      available: workers.filter((worker) => worker.available).length,
      capacity: workers.reduce((total, worker) => total + worker.capacity, 0),
      active: this.pendingJobs.size,
    };
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

  dispatch(
    job: ChatbotJob,
    capabilities: ChatbotWorkerCapability[] = [
      job.executionMode === "dev" ? "dev" : "chat",
    ],
  ): DispatchResult {
    const selected = this.selectWorker(capabilities);
    if (selected.status !== "accepted") return selected;
    return this.dispatchJob(job, selected.worker.id);
  }

  acquireWorkflow(
    capabilities: ChatbotWorkerCapability[] = ["chat"],
  ): AcquireWorkflowResult {
    const selected = this.selectWorker(capabilities);
    if (selected.status !== "accepted") return selected;

    const workflowId = randomUUID();
    this.workflows.set(workflowId, { workerId: selected.worker.id });

    return {
      status: "accepted",
      workflow: {
        dispatch: (job) => this.dispatchWorkflowJob(job, workflowId),
        route: (requiredCapabilities) =>
          this.routeWorkflow(workflowId, requiredCapabilities),
        release: () => {
          this.workflows.delete(workflowId);
        },
      },
    };
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

    const worker = socket.data.workerId
      ? this.workers.get(socket.data.workerId)
      : undefined;
    if (!worker || worker.socket !== socket) {
      socket.close(4003, "Connection replaced");
      return;
    }

    this.armHeartbeatTimeout(worker);

    if (message.type === "heartbeat") return;

    if (message.type === "availability") {
      worker.available = message.available;
      worker.capacity = Number.isFinite(message.capacity)
        ? Math.max(1, Math.min(16, Math.floor(message.capacity)))
        : 1;
      return;
    }

    if (message.type === "result") {
      this.finishJob(worker, message);
      return;
    }

    socket.close(4002, "Unexpected message");
  }

  close(socket: Socket) {
    this.clearAuthenticationTimer(socket);
    this.clearHeartbeatTimeout(socket);

    const workerId = socket.data.workerId;
    if (!workerId) return;

    const worker = this.workers.get(workerId);
    if (!worker || worker.socket !== socket) return;

    this.workers.delete(workerId);
    this.failPendingJobs(
      workerId,
      "The Codex worker disconnected while answering.",
    );
  }

  private dispatchWorkflowJob(
    job: ChatbotJob,
    workflowId: string,
  ): DispatchResult {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return { status: "offline" };
    if (workflow.activeJobId) return { status: "busy" };
    return this.dispatchJob(job, workflow.workerId, workflowId);
  }

  private dispatchJob(
    job: ChatbotJob,
    workerId: string,
    workflowId?: string,
  ): DispatchResult {
    const worker = this.workers.get(workerId);
    if (!worker?.available) return { status: "offline" };
    if (this.pendingJobs.has(job.id)) return { status: "busy" };
    if (!workflowId && this.usedSlots(workerId) >= worker.capacity) {
      return { status: "busy" };
    }

    const result = new Promise<MacAgentJobResult>((resolve) => {
      const timeoutMs =
        job.executionMode === "dev" && job.purpose === "answer"
          ? CHATBOT_DEV_JOB_TIMEOUT_MS
          : CHATBOT_JOB_TIMEOUT_MS;
      const timer = setTimeout(() => {
        const pendingJob = this.pendingJobs.get(job.id);
        if (!pendingJob) return;

        this.deletePendingJob(pendingJob);
        const activeWorker = this.workers.get(pendingJob.workerId);
        if (activeWorker)
          send(activeWorker.socket, { type: "cancel", jobId: job.id });
        resolve({ ok: false, error: "Local Codex timed out." });
      }, timeoutMs);

      const pendingJob = { id: job.id, workerId, workflowId, resolve, timer };
      this.pendingJobs.set(job.id, pendingJob);
      if (workflowId) {
        const workflow = this.workflows.get(workflowId);
        if (workflow) workflow.activeJobId = job.id;
      }
    });

    send(worker.socket, { type: "job", job });
    return { status: "accepted", result };
  }

  private routeWorkflow(
    workflowId: string,
    capabilities: ChatbotWorkerCapability[],
  ): WorkerSelectionResult {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return { status: "offline" };
    if (workflow.activeJobId) return { status: "busy" };

    const current = this.workers.get(workflow.workerId);
    if (
      current?.available &&
      capabilities.every((capability) => current.capabilities.has(capability))
    ) {
      return { status: "accepted" };
    }

    const selected = this.selectWorker(capabilities, workflowId);
    if (selected.status !== "accepted") return selected;
    workflow.workerId = selected.worker.id;
    return { status: "accepted" };
  }

  private selectWorker(
    capabilities: ChatbotWorkerCapability[],
    movingWorkflowId?: string,
  ):
    | { status: "offline" }
    | { status: "busy" }
    | { status: "accepted"; worker: Worker } {
    const compatible = [...this.workers.values()].filter(
      (worker) =>
        worker.available &&
        capabilities.every((capability) => worker.capabilities.has(capability)),
    );
    if (compatible.length === 0) return { status: "offline" };

    const available = compatible.filter(
      (worker) => this.usedSlots(worker.id, movingWorkflowId) < worker.capacity,
    );
    if (available.length === 0) return { status: "busy" };

    available.sort((left, right) => {
      const priority = right.priority - left.priority;
      if (priority !== 0) return priority;
      const utilization =
        this.usedSlots(left.id, movingWorkflowId) / left.capacity -
        this.usedSlots(right.id, movingWorkflowId) / right.capacity;
      return utilization || left.id.localeCompare(right.id);
    });
    return { status: "accepted", worker: available[0]! };
  }

  private authenticate(socket: Socket, message: MacAgentClientMessage) {
    const expectedSecret = this.configuredSecret();

    if (
      message.type !== "authenticate" ||
      message.protocolVersion !== CHATBOT_PROTOCOL_VERSION ||
      !expectedSecret ||
      !safeEqual(message.secret, expectedSecret) ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(message.workerId) ||
      !validCapabilities(message.capabilities) ||
      !Number.isFinite(message.priority)
    ) {
      socket.close(4001, "Authentication failed");
      return;
    }

    const oldWorker = this.workers.get(message.workerId);
    if (oldWorker && oldWorker.socket !== socket) {
      this.failPendingJobs(
        oldWorker.id,
        "The Codex worker reconnected while answering.",
      );
      oldWorker.socket.close(4003, "Connection replaced");
    }

    this.clearAuthenticationTimer(socket);
    socket.data.authenticated = true;
    socket.data.workerId = message.workerId;
    const worker: Worker = {
      id: message.workerId,
      socket,
      capabilities: new Set(message.capabilities),
      priority: Math.max(0, Math.min(1_000, Math.floor(message.priority))),
      available: false,
      capacity: 1,
    };
    this.workers.set(worker.id, worker);
    this.armHeartbeatTimeout(worker);
    send(socket, {
      type: "authenticated",
      protocolVersion: CHATBOT_PROTOCOL_VERSION,
    });
  }

  private finishJob(
    worker: Worker,
    message: Extract<MacAgentClientMessage, { type: "result" }>,
  ) {
    const pendingJob = this.pendingJobs.get(message.jobId);
    if (!pendingJob || pendingJob.workerId !== worker.id) return;

    this.deletePendingJob(pendingJob);
    clearTimeout(pendingJob.timer);
    pendingJob.resolve(
      message.ok
        ? { ok: true, content: message.content }
        : { ok: false, error: message.error },
    );
  }

  private failPendingJobs(workerId: string, error: string) {
    for (const pendingJob of this.pendingJobs.values()) {
      if (pendingJob.workerId !== workerId) continue;
      clearTimeout(pendingJob.timer);
      this.deletePendingJob(pendingJob);
      pendingJob.resolve({ ok: false, error });
    }
  }

  private deletePendingJob(pendingJob: PendingJob) {
    this.pendingJobs.delete(pendingJob.id);
    if (!pendingJob.workflowId) return;
    const workflow = this.workflows.get(pendingJob.workflowId);
    if (workflow?.activeJobId === pendingJob.id) {
      delete workflow.activeJobId;
    }
  }

  private usedSlots(workerId: string, ignoredWorkflowId?: string) {
    let slots = 0;
    for (const [workflowId, workflow] of this.workflows) {
      if (workflowId !== ignoredWorkflowId && workflow.workerId === workerId) {
        slots += 1;
      }
    }
    for (const pendingJob of this.pendingJobs.values()) {
      if (
        pendingJob.workerId === workerId &&
        (!pendingJob.workflowId || !this.workflows.has(pendingJob.workflowId))
      )
        slots += 1;
    }
    return slots;
  }

  private armHeartbeatTimeout(worker: Worker) {
    this.clearHeartbeatTimeout(worker.socket);
    const timer = setTimeout(() => {
      if (this.workers.get(worker.id)?.socket === worker.socket) {
        worker.socket.close(4004, "Heartbeat timeout");
      }
    }, 45_000);
    this.heartbeatTimers.set(worker.socket, timer);
  }

  private clearAuthenticationTimer(socket: Socket) {
    const timer = this.authenticationTimers.get(socket);
    if (!timer) return;
    clearTimeout(timer);
    this.authenticationTimers.delete(socket);
  }

  private clearHeartbeatTimeout(socket: Socket) {
    const timer = this.heartbeatTimers.get(socket);
    if (!timer) return;
    clearTimeout(timer);
    this.heartbeatTimers.delete(socket);
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
