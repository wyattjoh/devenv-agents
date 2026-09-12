import { describe, expect, it } from "bun:test";
import type { HerdrWorktree } from "../herdr-client.ts";
import { createFakeHerdrClient } from "./herdr-client.ts";

describe("fake Herdr client", () => {
  it("returns typed defaults and accepts operation overrides", () => {
    const worktrees: readonly HerdrWorktree[] = [
      {
        path: "/tmp/project/worktree/feature",
        branch: "feature",
        linked: true,
        openWorkspaceId: "workspace-1",
        prunable: false,
      },
    ];
    const client = createFakeHerdrClient({
      listWorktrees: () => worktrees,
    });

    expect(client.listWorktrees(undefined)).toBe(worktrees);
    expect(client.listPlugins()).toEqual([]);
    expect(client.listPanes()).toEqual([]);
    expect(
      client.createWorktree({
        cwd: "/tmp/project",
        branch: "feature",
        base: undefined,
        path: "/tmp/project/worktree/feature",
        label: "feature",
        focus: "no-focus",
      }),
    ).toEqual({ workspaceId: "fake-workspace", rootPaneId: "fake-root-pane" });
  });
});
