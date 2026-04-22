import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
    emitTo as tauriEmitTo,
    listen as tauriListen,
} from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
    WebviewWindow,
    getAllWebviewWindows,
    getCurrentWebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { NeverWriteRuntime } from "./types";

export const tauriRuntime = {
    name: "tauri",
    invoke: tauriInvoke,
    listen: tauriListen,
    emitTo: tauriEmitTo,
    open,
    confirm,
    openPath,
    revealItemInDir,
    openUrl,
    getCurrentWindow,
    getCurrentWebview,
    getCurrentWebviewWindow,
    getAllWebviewWindows,
    WebviewWindow,
    LogicalPosition,
} as unknown as NeverWriteRuntime;
