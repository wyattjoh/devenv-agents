import type {
  WorktreeBootstrap,
  WorktreeBootstrapInspection,
  WorktreeBootstrapResult,
} from "../worktree-bootstrap.ts";

/**
 * Per-verb overrides for a fake bootstrap service.
 */
export type FakeWorktreeBootstrapOverrides = Partial<WorktreeBootstrap>;

type WorktreeBootstrapRequestResult = ReturnType<WorktreeBootstrap["request"]>;

const noneInspection = (): WorktreeBootstrapInspection => ({
  state: "none",
  error: undefined,
  startedAt: undefined,
  finishedAt: undefined,
});

const requested = (): WorktreeBootstrapRequestResult => ({
  state: "running",
  claimed: true,
  opened: true,
  error: undefined,
});

const completed = (): WorktreeBootstrapResult => ({
  exitCode: 0,
  state: "done",
  error: undefined,
});

/**
 * Creates a side-effect-free bootstrap service for caller tests.
 *
 * Each verb has a successful or empty default and can be replaced independently
 * to assert the caller's interaction and outcome handling without reaching into
 * bootstrap persistence.
 *
 * @param overrides Verb implementations to replace for one test.
 * @returns A bootstrap service suitable for dependency injection.
 */
export const createFakeWorktreeBootstrap = (
  overrides: FakeWorktreeBootstrapOverrides | undefined = {},
): WorktreeBootstrap => ({
  request: () => requested(),
  run: () => completed(),
  await: () => ({ state: "done", error: undefined }),
  inspect: () => noneInspection(),
  forget: () => undefined,
  ...overrides,
});
