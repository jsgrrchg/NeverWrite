export const ELECTRON_IPC = {
    invoke: "neverwrite:invoke",
    event: "neverwrite:event",
    emitTo: "neverwrite:event:emit-to",
    dialogOpen: "neverwrite:dialog:open",
    dialogConfirm: "neverwrite:dialog:confirm",
    openerOpenPath: "neverwrite:opener:open-path",
    openerRevealItem: "neverwrite:opener:reveal-item",
    openerOpenUrl: "neverwrite:opener:open-url",
    currentWindowLabel: "neverwrite:window:current-label",
    allWindows: "neverwrite:window:all",
    createWindow: "neverwrite:window:create",
    windowCommand: "neverwrite:window:command",
    windowEvent: "neverwrite:window:event",
} as const;

export interface IpcInvokeEnvelope {
    command: string;
    args?: Record<string, unknown>;
}

export interface IpcRuntimeEventEnvelope {
    eventName: string;
    payload: unknown;
}

export interface IpcWindowCommandEnvelope {
    label: string | null;
    command: string;
    args?: Record<string, unknown>;
}
