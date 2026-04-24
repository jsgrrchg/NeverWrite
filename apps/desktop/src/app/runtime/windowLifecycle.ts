import type { RuntimeWebviewWindow } from "./types";

export const DESKTOP_WINDOW_CREATED_EVENT = "neverwrite:window-created";
export const DESKTOP_WINDOW_ERROR_EVENT = "neverwrite:window-error";

function toWindowCreationError(payload: unknown) {
    if (payload instanceof Error) {
        return payload;
    }

    if (typeof payload === "string" && payload.trim().length > 0) {
        return new Error(payload);
    }

    return new Error("Desktop window creation failed.");
}

export async function waitForWindowReady(windowHandle: RuntimeWebviewWindow) {
    await new Promise<void>((resolve, reject) => {
        void windowHandle.once(DESKTOP_WINDOW_CREATED_EVENT, () => resolve());
        void windowHandle.once(DESKTOP_WINDOW_ERROR_EVENT, (event) => {
            reject(toWindowCreationError(event.payload));
        });
    });
}
