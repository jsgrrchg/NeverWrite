export type TerminalSessionStatus =
    | "idle"
    | "starting"
    | "running"
    | "exited"
    | "error";

export interface TerminalSessionSnapshot {
    sessionId: string;
    program: string;
    status: TerminalSessionStatus;
    displayName: string;
    cwd: string;
    cols: number;
    rows: number;
    exitCode: number | null;
    errorMessage: string | null;
}

export interface TerminalOutputEventPayload {
    sessionId: string;
    chunk: string;
}

export interface TerminalErrorEventPayload {
    sessionId: string;
    message: string;
}

export interface TerminalSessionCreateInput {
    cwd?: string | null;
    cols?: number;
    rows?: number;
    extraEnv?: Record<string, string>;
}

export const DEV_TERMINAL_OUTPUT_EVENT = "devtools://terminal-output";
export const DEV_TERMINAL_STARTED_EVENT = "devtools://terminal-started";
export const DEV_TERMINAL_EXITED_EVENT = "devtools://terminal-exited";
export const DEV_TERMINAL_ERROR_EVENT = "devtools://terminal-error";

// A command delivered to a mounted terminal viewport. Output is piped straight
// to xterm via "write"; "clear" wipes the screen. The viewport — not app state —
// is the source of truth for screen content, so these are transient.
export type TerminalOutputCommand =
    | { type: "write"; data: string }
    | { type: "clear" };

export interface TerminalSessionView {
    snapshot: TerminalSessionSnapshot;
    // Whether any output has been produced this session. Drives empty-state UI
    // only; the actual content lives in the xterm instance, not here.
    hasOutput: boolean;
    busy: boolean;
    writeInput: (input: string) => Promise<void>;
    resize: (cols: number, rows: number) => Promise<void>;
    restart: () => Promise<void>;
    clearViewport: () => void;
    // Subscribe to live output commands for this terminal. Any commands buffered
    // before the first subscriber attaches are flushed on subscribe. Returns an
    // unsubscribe function.
    subscribeOutput: (
        listener: (command: TerminalOutputCommand) => void,
    ) => () => void;
    // Reattach support: a serialized xterm buffer snapshot, written back on mount
    // to restore screen content across remounts and reloads.
    getReplaySnapshot: () => string | null;
    saveReplaySnapshot: (serialized: string) => void;
}

export const EMPTY_TERMINAL_SNAPSHOT: TerminalSessionSnapshot = {
    sessionId: "",
    program: "",
    status: "idle",
    displayName: "Shell",
    cwd: "",
    cols: 120,
    rows: 24,
    exitCode: null,
    errorMessage: null,
};
