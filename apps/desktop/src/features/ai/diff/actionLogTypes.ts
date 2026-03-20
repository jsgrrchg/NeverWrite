/**
 * ActionLog types — Patch-based change tracking with author attribution.
 *
 * Inspired by Zed's ActionLog system. Replaces the static baseText/appliedText
 * snapshot model with incremental line-range patches that evolve as the user
 * edits alongside the agent.
 */

// ---------------------------------------------------------------------------
// Patch primitives
// ---------------------------------------------------------------------------

/** A single edit expressed as line ranges (0-based, end-exclusive). */
export interface LineEdit {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

/** Ordered, non-overlapping collection of line edits. */
export interface LinePatch {
  edits: LineEdit[];
}

/** A single edit expressed as text offsets (0-based, end-exclusive). */
export interface TextEdit {
  oldFrom: number;
  oldTo: number;
  newFrom: number;
  newTo: number;
}

/** A pending agent-authored span tracked across base/current documents. */
export interface AgentTextSpan {
  baseFrom: number;
  baseTo: number;
  currentFrom: number;
  currentTo: number;
}

/** Ordered, non-overlapping collection of agent text spans. */
export interface TextRangePatch {
  spans: AgentTextSpan[];
}

export interface WordDiffRange {
  from: number;
  to: number;
  baseFrom: number;
  baseTo: number;
}

export interface HunkWordDiffs {
  bufferRanges: WordDiffRange[];
  baseRanges: WordDiffRange[];
}

// ---------------------------------------------------------------------------
// Change attribution
// ---------------------------------------------------------------------------

export type ChangeAuthor = "user" | "agent";

export type ReviewState = "pending" | "finalized";

// ---------------------------------------------------------------------------
// File lifecycle
// ---------------------------------------------------------------------------

export type TrackedFileStatus =
  | { kind: "created"; existingFileContent: string | null }
  | { kind: "modified" }
  | { kind: "deleted" };

// ---------------------------------------------------------------------------
// Core tracked file
// ---------------------------------------------------------------------------

export interface TrackedFile {
  /** Stable identity key (path at creation time). */
  identityKey: string;
  /** Path where the file originally lived. */
  originPath: string;
  /** Current path on disk. */
  path: string;
  /** Previous path if the file was moved/renamed. */
  previousPath: string | null;
  /** Lifecycle state — determines reject behaviour. */
  status: TrackedFileStatus;
  /**
   * Whether the current diff is still in-flight for the active work cycle or
   * ready for user review. Optional for compatibility with persisted sessions
   * created before reviewState existed.
   */
  reviewState?: ReviewState;
  /**
   * Baseline text. Evolves when the *user* makes non-conflicting edits so
   * that `diffBase → currentText` always shows only the agent's work.
   */
  diffBase: string;
  /** Full text as last applied by the agent. */
  currentText: string;
  /**
   * Agent edits still pending review (text ranges).
   *
   * Optional for lazy compatibility with persisted sessions created before
   * the offset-based transitional model existed.
   */
  unreviewedRanges?: TextRangePatch;
  /** Agent edits still pending review (line ranges, derived/cache). */
  unreviewedEdits: LinePatch;
  /** Monotonic version counter — bumped on every mutation. */
  version: number;
  /** Whether this is a text file (binary files get limited UI). */
  isText: boolean;
  /** Timestamp of last modification. */
  updatedAt: number;
  /** Non-null when a conflict was detected during reject. */
  conflictHash?: string | null;
}

// ---------------------------------------------------------------------------
// Undo system
// ---------------------------------------------------------------------------

export interface PerFileUndo {
  path: string;
  /** Ranges + original agent text to restore on undo. */
  editsToRestore: Array<{
    startLine: number;
    endLine: number;
    text: string;
  }>;
  /** File status before the reject (needed to restore lifecycle state). */
  previousStatus: TrackedFileStatus;
}

export interface LastRejectUndo {
  buffers: PerFileUndo[];
  /** Full TrackedFile snapshots before rejection, keyed by identityKey. */
  snapshots: Record<string, TrackedFile>;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Top-level state shape (lives inside AIChatSession)
// ---------------------------------------------------------------------------

export interface ActionLogState {
  trackedFilesByWorkCycleId: Record<string, Record<string, TrackedFile>>;
  lastRejectUndo: LastRejectUndo | null;
}
