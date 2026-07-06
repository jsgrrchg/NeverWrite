import { handleWebClipperDeepLink } from "./webClipper";

const DEEP_LINK_OPEN_FILE_EVENT = "neverwrite:deep-link/open-file";

export interface DeepLinkOpenFileRequest {
    path: string;
    line: number | null;
    endLine: number | null;
}

type EmitEvent = (eventName: string, payload: unknown) => void;

const pendingOpenLinks: string[] = [];
let emitEvent: EmitEvent | null = null;

/**
 * Wire the deep-link runtime to the renderer event bus. `neverwrite://open`
 * links that arrived before the runtime was installed are flushed here. This
 * mirrors the web-clipper runtime; on a true cold launch the renderer may still
 * be mounting, so guaranteed cold-start delivery would need a renderer-pull
 * handshake (tracked as follow-up).
 */
export function installDeepLinkRuntime(emit: EmitEvent) {
    emitEvent = emit;
    const queued = pendingOpenLinks.splice(0);
    for (const rawUrl of queued) {
        dispatchOpenDeepLink(rawUrl);
    }
}

/**
 * Pick out every NeverWrite deep link from a process argv list. Windows and
 * Linux deliver the URL as a command-line argument via `second-instance`.
 */
export function extractDeepLinksFromArgv(argv: string[]) {
    return argv.filter((arg) => arg.startsWith("neverwrite://"));
}

/**
 * Generic dispatcher for `neverwrite://` deep links. Keeps the existing
 * `neverwrite://clip` web-clipper flow untouched and adds `neverwrite://open`.
 */
export function handleDeepLink(rawUrl: string) {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        console.warn(`[deep-link] Ignoring malformed deep link: ${rawUrl}`);
        return;
    }

    if (url.protocol !== "neverwrite:") return;

    switch (deepLinkAction(url)) {
        case "clip":
            handleWebClipperDeepLink(rawUrl);
            return;
        case "open":
            dispatchOpenDeepLink(rawUrl);
            return;
        default:
            console.warn(
                `[deep-link] Unsupported deep link action: ${deepLinkAction(url)}`,
            );
    }
}

/**
 * The action is normally the URL authority (`neverwrite://open?...`), but also
 * accept the authority-less form `neverwrite:open?...`, where the action lands
 * in the (opaque) path instead. Both are common in hand-written links.
 */
function deepLinkAction(url: URL): string {
    if (url.hostname) return url.hostname;
    return url.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
}

function dispatchOpenDeepLink(rawUrl: string) {
    const request = parseOpenDeepLink(rawUrl);
    if (!request) {
        console.warn(`[deep-link] Ignoring invalid open deep link: ${rawUrl}`);
        return;
    }
    if (!emitEvent) {
        pendingOpenLinks.push(rawUrl);
        return;
    }
    emitEvent(DEEP_LINK_OPEN_FILE_EVENT, request);
}

/**
 * Parse `neverwrite://open?path=<url-encoded-path>` with an optional
 * `#L10` / `#L10-L20` line fragment. The path is validated and resolved
 * against the open vault later, in the renderer.
 */
export function parseOpenDeepLink(rawUrl: string): DeepLinkOpenFileRequest | null {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }

    if (url.protocol !== "neverwrite:" || deepLinkAction(url) !== "open") {
        return null;
    }

    let path = url.searchParams.get("path")?.trim();
    if (!path) return null;

    // Line info is normally the URL fragment (`...?path=x#L10`), but tolerate a
    // fragment that was percent-encoded into the `path` value itself. Only peel
    // off a suffix that is a complete line fragment, so filenames that legitimately
    // contain `#L<digit>` (e.g. `Report#L2 draft.md`) are left intact.
    let fragment = url.hash;
    if (!fragment) {
        const inlineFragment = /#L\d+(?:-L?\d+)?$/.exec(path);
        if (inlineFragment) {
            fragment = inlineFragment[0];
            path = path.slice(0, inlineFragment.index).trim();
            if (!path) return null;
        }
    }

    const { line, endLine } = parseLineFragment(fragment);
    return { path, line, endLine };
}

function parseLineFragment(fragment: string): {
    line: number | null;
    endLine: number | null;
} {
    // Accepts `#L10`, `#L10-L20`, and `#L10-20`.
    const match = /^#L(\d+)(?:-L?(\d+))?$/.exec(fragment);
    if (!match) return { line: null, endLine: null };

    const line = toPositiveInt(match[1]);
    const endLine = match[2] ? toPositiveInt(match[2]) : null;
    return { line, endLine };
}

function toPositiveInt(value: string): number | null {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
