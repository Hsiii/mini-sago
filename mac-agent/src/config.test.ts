import { describe, expect, test } from "bun:test";

import { workspaceChild } from "./config";

describe("worker configuration", () => {
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
