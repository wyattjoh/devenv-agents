/**
 * Compatibility exports for callers that have not migrated to the bootstrap
 * verbs yet. The state implementation and on-disk layout live in the bootstrap
 * module's private state adapter and will be removed with this compatibility
 * surface in the caller-migration ticket.
 */
export {
  claimWorktreeStatus,
  getWorktreeStatusPaths,
  listWorktreeStatuses,
  readWorktreeStatus,
  removeWorktreeStatusEntry,
  worktreeStatusHash,
} from "./worktree-bootstrap-state.ts";

export type {
  DoneWorktreeStatus,
  FailedWorktreeStatus,
  RunningWorktreeStatus,
  WorktreeStatus,
  WorktreeStatusClaim,
  WorktreeStatusEntry,
  WorktreeStatusPaths,
  WorktreeStatusState,
} from "./worktree-bootstrap-state.ts";
