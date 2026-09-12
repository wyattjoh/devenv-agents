import type { HerdrClient } from "../herdr-client.ts";

/**
 * Per-operation overrides for an in-memory Herdr client.
 */
export type FakeHerdrClientOverrides = Partial<HerdrClient>;

/**
 * Creates an in-memory Herdr client for caller tests.
 *
 * Every operation has a typed, side-effect-free default. Tests can replace only
 * the operation under test without constructing Herdr JSON envelopes or
 * recording command arguments.
 *
 * @param overrides Operation implementations to replace for one test.
 * @returns A Herdr client suitable for dependency injection.
 */
export const createFakeHerdrClient = (
  overrides: FakeHerdrClientOverrides | undefined = {},
): HerdrClient => ({
  listWorktrees: () => [],
  resolveWorktree: () => undefined,
  createWorktree: () => ({ workspaceId: "fake-workspace", rootPaneId: "fake-root-pane" }),
  openWorktree: () => undefined,
  closeWorkspace: () => undefined,
  openPluginPane: () => undefined,
  sendKeys: () => undefined,
  listPlugins: () => [],
  linkPlugin: () => undefined,
  enablePlugin: () => undefined,
  unlinkPlugin: () => undefined,
  listPanes: () => [],
  ...overrides,
});
