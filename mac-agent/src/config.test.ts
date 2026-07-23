import { describe, expect, test } from "bun:test";

import {
  defaultWorkerCapabilities,
  validateBridgeUrl,
  workspaceChild,
} from "./config";

describe("worker configuration", () => {
  test("advertises enforced dev profiles independently from the Mac target", () => {
    expect(defaultWorkerCapabilities(true)).toBe("chat,dev");
    expect(defaultWorkerCapabilities(false)).toBe("chat,dev,mac");
  });

  test("allows plaintext bridge traffic only for local hostnames", () => {
    expect(validateBridgeUrl("ws://bot-core:3000/api/mac-agent/ws")).toBe(
      "ws://bot-core:3000/api/mac-agent/ws",
    );
    expect(validateBridgeUrl("ws://[::1]:3000/api/mac-agent/ws")).toBe(
      "ws://[::1]:3000/api/mac-agent/ws",
    );
    expect(validateBridgeUrl("wss://bot.example.com/api/mac-agent/ws")).toBe(
      "wss://bot.example.com/api/mac-agent/ws",
    );
    expect(() =>
      validateBridgeUrl("ws://bot.example.com/api/mac-agent/ws"),
    ).toThrow("must use wss://");
    expect(() =>
      validateBridgeUrl("ws://[2001:db8::1]/api/mac-agent/ws"),
    ).toThrow("must use wss://");
    expect(() =>
      validateBridgeUrl("ws://[2606:4700:4700::1111]/api/mac-agent/ws"),
    ).toThrow("must use wss://");
  });

  test("keeps GitHub worktree roots inside the dev workspace", () => {
    expect(
      workspaceChild(
        "/workspace",
        "/workspace/worktrees",
        "MINISAGO_GITHUB_WORKTREE_ROOT",
      ),
    ).toBe("/workspace/worktrees");
    expect(() =>
      workspaceChild(
        "/workspace",
        "/private/worktrees",
        "MINISAGO_GITHUB_WORKTREE_ROOT",
      ),
    ).toThrow("must be a directory inside MINISAGO_WORKSPACE_ROOT");
    expect(() =>
      workspaceChild(
        "/workspace",
        "/workspace",
        "MINISAGO_GITHUB_WORKTREE_ROOT",
      ),
    ).toThrow("must be a directory inside MINISAGO_WORKSPACE_ROOT");
  });
});
