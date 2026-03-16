import type { TerminalBufferState } from "./terminalBuffer";

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
}

export const DEV_TERMINAL_OUTPUT_EVENT = "devtools://terminal-output";
export const DEV_TERMINAL_STARTED_EVENT = "devtools://terminal-started";
export const DEV_TERMINAL_EXITED_EVENT = "devtools://terminal-exited";
export const DEV_TERMINAL_ERROR_EVENT = "devtools://terminal-error";

export interface TerminalSessionView {
    snapshot: TerminalSessionSnapshot;
    output: string;
    bufferState: TerminalBufferState;
    busy: boolean;
    writeInput: (input: string) => Promise<void>;
    resize: (cols: number, rows: number) => Promise<void>;
    restart: () => Promise<void>;
    clearViewport: () => void;
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
