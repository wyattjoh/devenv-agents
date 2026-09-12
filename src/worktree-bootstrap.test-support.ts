import { rmSync } from "node:fs";
import { claimWorktreeStatus, getWorktreeStatusPaths } from "./worktree-bootstrap-state.ts";

/**
 * Leaves the bootstrap state in the shape produced by an owner that crashed
 * after adopting a handoff but before persisting its status.
 *
 * This helper is intentionally test-only. It keeps persistence details inside
 * the bootstrap module's test support so verb tests assert only public results.
 *
 * @param mainCheckout Main checkout containing the bootstrap state.
 * @param worktreePath Worktree whose bootstrap should be made stale.
 * @returns Nothing; the next bootstrap run owns recovery.
 */
export const leaveStaleOwnerBootstrap = (mainCheckout: string, worktreePath: string): void => {
  const eventClaim = claimWorktreeStatus(
    mainCheckout,
    worktreePath,
    () => "2026-09-08T01:00:00.000Z",
  );
  if (eventClaim === undefined) throw new Error("failed to create bootstrap request claim");
  eventClaim.write("running", undefined, undefined);
  eventClaim.handoff();

  const ownerClaim = claimWorktreeStatus(mainCheckout, worktreePath, undefined, undefined, true);
  if (ownerClaim === undefined) throw new Error("failed to adopt bootstrap request claim");
  const paths = getWorktreeStatusPaths(mainCheckout, worktreePath);
  rmSync(paths.statusPath, { force: true });
};
