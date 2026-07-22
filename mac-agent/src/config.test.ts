import { describe, expect, test } from "bun:test";

import { validateBridgeUrl, workspaceChild } from "./config";

describe("worker configuration", () => {
  test("allows plaintext bridge traffic only for local hostnames", () => {
    expect(validateBridgeUrl("ws://bot-core:3000/api/mac-agent/ws")).toBe(
      "ws://bot-core:3000/api/mac-agent/ws",
    );
    expect(validateBridgeUrl("wss://bot.example.com/api/mac-agent/ws")).toBe(
      "wss://bot.example.com/api/mac-agent/ws",
    );
    expect(() =>
      validateBridgeUrl("ws://bot.example.com/api/mac-agent/ws"),
    ).toThrow("must use wss://");
  });

  test("keeps GitHub clone and worktree roots inside the dev workspace", () => {
    expect(
      workspaceChild(
        "/workspace",
        "/workspace/repositories",
        "MINISAGO_GITHUB_REPOSITORY_ROOT",
      ),
    ).toBe("/workspace/repositories");
    expect(() =>
      workspaceChild(
        "/workspace",
        "/private/repositories",
        "MINISAGO_GITHUB_REPOSITORY_ROOT",
      ),
    ).toThrow("must be a directory inside MINISAGO_WORKSPACE_ROOT");
    expect(() =>
      workspaceChild(
        "/workspace",
        "/workspace",
        "MINISAGO_GITHUB_REPOSITORY_ROOT",
      ),
    ).toThrow("must be a directory inside MINISAGO_WORKSPACE_ROOT");
  });
});
