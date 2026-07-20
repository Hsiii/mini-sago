import {
  CHATBOT_PROTOCOL_VERSION,
  type ChatbotJob,
  type MacAgentClientMessage,
  type MacAgentServerMessage,
} from "../../lib/chatbot/protocol";
import type { MacAgentConfig } from "./config";
import { checkCodexAuthentication, runCodexJob } from "./codex";
import { SessionMonitor } from "./session-monitor";

const HEARTBEAT_INTERVAL_MS = 20_000;
const AUTH_RETRY_MS = 30_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

function parseServerMessage(value: unknown) {
  try {
    return JSON.parse(String(value)) as MacAgentServerMessage;
  } catch {
    return null;
  }
}

export class MacAgentClient {
  private authenticated = false;
  private authRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private currentJob: { id: string; controller: AbortController } | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionMonitor: SessionMonitor;
  private socket: WebSocket | null = null;
  private stopped = false;
  private unlocked = false;

  constructor(private readonly config: MacAgentConfig) {
    this.sessionMonitor = new SessionMonitor(
      config.sessionMonitorPath,
      (state) => void this.handleSessionState(state),
    );
  }

  start() {
    this.sessionMonitor.start();
    console.log("MiniSago Mac helper started.");
  }

  stop() {
    this.stopped = true;
    this.unlocked = false;
    this.clearTimers();
    this.currentJob?.controller.abort();
    this.currentJob = null;
    this.socket?.close(1000, "Helper stopped");
    this.socket = null;
    this.sessionMonitor.stop();
  }

  private async handleSessionState(state: "locked" | "unlocked") {
    if (state === "locked") {
      this.unlocked = false;
      this.authenticated = false;
      this.clearTimers();
      this.currentJob?.controller.abort();
      this.currentJob = null;
      this.socket?.close(1000, "Mac locked or sleeping");
      this.socket = null;
      console.log("Mac locked; chatbot unavailable.");
      return;
    }

    if (this.unlocked || this.stopped) {
      return;
    }

    this.unlocked = true;
    await this.connectWhenReady();
  }

  private async connectWhenReady() {
    if (!this.unlocked || this.stopped || this.socket) {
      return;
    }

    const authenticated = await checkCodexAuthentication(this.config);
    if (!authenticated) {
      console.warn("Local Codex authentication unavailable; chatbot offline.");
      this.authRetryTimer = setTimeout(
        () => void this.connectWhenReady(),
        AUTH_RETRY_MS,
      );
      return;
    }

    this.openSocket();
  }

  private openSocket() {
    if (!this.unlocked || this.stopped || this.socket) {
      return;
    }

    const socket = new WebSocket(this.config.bridgeUrl);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.send({
        type: "authenticate",
        protocolVersion: CHATBOT_PROTOCOL_VERSION,
        secret: this.config.bridgeSecret,
      });
    });
    socket.addEventListener("message", (event) => {
      void this.handleServerMessage(event.data);
    });
    socket.addEventListener("close", () => {
      if (socket !== this.socket) {
        return;
      }

      this.socket = null;
      this.authenticated = false;
      this.stopHeartbeat();
      this.currentJob?.controller.abort();
      this.currentJob = null;
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  private async handleServerMessage(rawMessage: unknown) {
    const message = parseServerMessage(rawMessage);
    if (!message) {
      this.socket?.close(4002, "Invalid server message");
      return;
    }

    if (message.type === "authenticated") {
      if (message.protocolVersion !== CHATBOT_PROTOCOL_VERSION) {
        this.socket?.close(4002, "Protocol mismatch");
        return;
      }

      this.authenticated = true;
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.send({ type: "availability", available: true });
      console.log("Mac unlocked; chatbot available.");
      return;
    }

    if (!this.authenticated) {
      this.socket?.close(4001, "Server message before authentication");
      return;
    }

    if (message.type === "cancel") {
      if (this.currentJob?.id === message.jobId) {
        this.currentJob.controller.abort();
      }
      return;
    }

    if (message.type === "job") {
      await this.handleJob(message.job);
    }
  }

  private async handleJob(job: ChatbotJob) {
    if (this.currentJob) {
      this.send({
        type: "result",
        jobId: job.id,
        ok: false,
        error: "Mac helper is busy.",
      });
      return;
    }

    const controller = new AbortController();
    this.currentJob = { id: job.id, controller };
    const startedAt = Date.now();
    console.log(`Job ${job.id} started.`);

    try {
      const content = await runCodexJob(job, {
        ...this.config,
        signal: controller.signal,
      });

      if (!controller.signal.aborted && this.authenticated) {
        this.currentJob = null;
        this.send({ type: "result", jobId: job.id, ok: true, content });
      }
      console.log(`Job ${job.id} finished in ${Date.now() - startedAt} ms.`);
    } catch (error) {
      if (!controller.signal.aborted && this.authenticated) {
        this.currentJob = null;
        this.send({
          type: "result",
          jobId: job.id,
          ok: false,
          error: error instanceof Error ? error.message : "Codex failed.",
        });
      }
      console.error(`Job ${job.id} failed after ${Date.now() - startedAt} ms.`);
    } finally {
      if (this.currentJob?.id === job.id) {
        this.currentJob = null;
      }
    }
  }

  private send(message: MacAgentClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "heartbeat" });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private scheduleReconnect() {
    if (!this.unlocked || this.stopped) {
      return;
    }

    const delay = Math.min(
      1_000 * 2 ** this.reconnectAttempts,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => void this.connectWhenReady(), delay);
  }

  private clearTimers() {
    this.stopHeartbeat();

    if (this.authRetryTimer) {
      clearTimeout(this.authRetryTimer);
      this.authRetryTimer = undefined;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
