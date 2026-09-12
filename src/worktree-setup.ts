import type { CommandRunner } from "./command-runner.ts";
import type { HerdrClient } from "./herdr-client.ts";
import type { SyncReferences } from "./project-sync.ts";
import {
  runWorktreeBootstrap,
  type WorktreeBootstrapIO,
  type WorktreeBootstrapResult,
} from "./worktree-bootstrap.ts";
import { getWorktreeStatusPaths } from "./worktree-status.ts";
import { resolveMainCheckout } from "./workspace.ts";

/**
 * Compatibility export for the reference synchronization request seam.
 */
export type { SyncReferences, SyncRequest } from "./project-sync.ts";

/**
 * Dependencies and paths needed for one worktree setup attempt.
 */
export type WorktreeSetupOptions = {
  readonly worktreePath: string;
  readonly mainCheckout: string | undefined;
  readonly herdrClient: HerdrClient;
  readonly runner: CommandRunner;
  readonly syncReferences: SyncReferences;
  readonly now: (() => string) | undefined;
  readonly allowCompleted: boolean | undefined;
};

/**
 * Result of a worktree setup attempt.
 */
export type WorktreeSetupResult = {
  readonly exitCode: number;
  readonly statusPath: string;
  readonly claimPath: string;
  readonly state: "running" | "done" | "failed" | undefined;
  readonly error: string | undefined;
};

type ResolvedSetupOptions = WorktreeSetupOptions & {
  readonly mainCheckout: string;
  readonly io: WorktreeBootstrapIO | undefined;
};

const setupOptions = (
  options: WorktreeSetupOptions,
  io: WorktreeBootstrapIO | undefined,
): ResolvedSetupOptions => ({
  ...options,
  mainCheckout: options.mainCheckout ?? resolveMainCheckout(options.worktreePath, options.runner),
  io,
});

const setupResult = (
  mainCheckout: string,
  worktreePath: string,
  result: WorktreeBootstrapResult,
): WorktreeSetupResult => {
  const paths = getWorktreeStatusPaths(mainCheckout, worktreePath);
  const error =
    result.error === "worktree bootstrap is already claimed"
      ? "worktree setup is already claimed"
      : result.error;
  return {
    exitCode: result.exitCode,
    statusPath: paths.statusPath,
    claimPath: paths.claimPath,
    state: result.state,
    error,
  };
};

const runSetup = (
  options: WorktreeSetupOptions,
  io: WorktreeBootstrapIO | undefined,
): WorktreeSetupResult => {
  const resolved = setupOptions(options, io);
  const result = runWorktreeBootstrap(resolved);
  return setupResult(resolved.mainCheckout, resolved.worktreePath, result);
};

/**
 * Runs one complete worktree bootstrap through the compatibility setup name.
 *
 * @param options Setup paths and injected dependencies.
 * @returns The exit code and legacy status locations.
 */
export const runWorktreeSetup = (options: WorktreeSetupOptions): WorktreeSetupResult =>
  runSetup(options, undefined);

/**
 * Runs setup repeatedly in interactive mode until it succeeds or the user quits.
 *
 * @param options Setup paths and injected dependencies.
 * @param readLine Reads one retry decision; an empty line retries, q/quit exits.
 * @param onFailure Optional callback used to keep the failure and retry prompt visible.
 * @returns The final setup result.
 */
export const runInteractiveWorktreeSetup = (
  options: WorktreeSetupOptions,
  readLine: () => string,
  onFailure: ((result: WorktreeSetupResult) => void) | undefined = undefined,
): WorktreeSetupResult => {
  const resolved = setupOptions(options, {
    readLine,
    onFailure: (result) => {
      onFailure?.(setupResult(resolved.mainCheckout, resolved.worktreePath, result));
    },
  });
  const result = runWorktreeBootstrap(resolved);
  return setupResult(resolved.mainCheckout, resolved.worktreePath, result);
};
