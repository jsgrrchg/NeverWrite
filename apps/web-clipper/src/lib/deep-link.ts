import type { ClipRequestPayload } from "./clip-request";
import { DEEP_LINK_SCHEME } from "./technical-branding";

export function createClipDeepLink(payload: ClipRequestPayload): string {
    const params = new URLSearchParams();

    params.set("requestId", payload.requestId);
    params.set("createdAt", payload.createdAt);
    params.set("source", payload.source);
    params.set("vault", payload.vault);
    if (payload.vaultPathHint) {
        params.set("vaultPathHint", payload.vaultPathHint);
    }
    if (payload.vaultNameHint) {
        params.set("vaultNameHint", payload.vaultNameHint);
    }
    params.set("folder", payload.folder);
    params.set("title", payload.title);
    params.set("url", payload.url);
    params.set("mode", payload.mode);

    if (payload.mode === "inline" && payload.content) {
        params.set("content", payload.content);
    }

    if (payload.mode === "clipboard" && payload.clipboardToken) {
        params.set("clipboardToken", payload.clipboardToken);
    }

    return `${DEEP_LINK_SCHEME}://clip?${params.toString()}`;
}

export function openDeepLink(uri: string): void {
    const openedWindow = window.open(uri, "_blank", "noopener,noreferrer");
    if (openedWindow === null) {
        window.location.href = uri;
    }
}
