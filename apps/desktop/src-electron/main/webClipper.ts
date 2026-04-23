import crypto from "node:crypto";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { app, clipboard } from "electron";
import type { ElectronVaultBackend } from "./vaultBackend";

const WEB_CLIPPER_API_PORT = 32145;
const WEB_CLIPPER_AUTH_FILE = "web_clipper_auth.json";
const CLIPPER_TOKEN_HEADER = "x-neverwrite-clipper-token";
const CLIPPER_EXTENSION_ID_HEADER = "x-neverwrite-extension-id";
const CHROME_EXTENSION_ID = "pogmjgibofkooljfgaandhoinmenfhao";
const FIREFOX_EXTENSION_ID = "web-clipper@neverwrite.app";
const WEB_CLIPPER_CLIP_SAVED_EVENT = "neverwrite:web-clipper/clip-saved";
const WEB_CLIPPER_ROUTE_CLIP_EVENT = "neverwrite:web-clipper/route-clip";

type Runtime = {
    backend: ElectronVaultBackend;
    emitEvent: (eventName: string, payload: unknown) => void;
};

type AuthorizedClipper = {
    origin: string;
    identity: "official-chrome" | "official-firefox" | "explicit-dev";
};

type AuthState = {
    token: string;
    firefoxOrigin?: string | null;
};

const pendingDeepLinks: string[] = [];
let runtime: Runtime | null = null;
let serverStarted = false;

export function installWebClipperRuntime(
    backend: ElectronVaultBackend,
    emitEvent: (eventName: string, payload: unknown) => void,
) {
    runtime = { backend, emitEvent };
    startWebClipperServer();
    const queued = pendingDeepLinks.splice(0);
    for (const url of queued) {
        void handleWebClipperDeepLink(url);
    }
}

export function extractWebClipperDeepLinksFromArgv(argv: string[]) {
    return argv.filter((arg) => arg.startsWith("neverwrite://clip"));
}

export function handleWebClipperDeepLink(rawUrl: string) {
    if (!runtime) {
        pendingDeepLinks.push(rawUrl);
        return;
    }

    void (async () => {
        const request = parseWebClipperDeepLink(rawUrl);
        const content =
            request.mode === "clipboard"
                ? clipboard.readText().trim()
                : (request.content ?? "").trim();
        if (!content) {
            throw new Error("Clip content is empty.");
        }
        const payload = await runtime!.backend.invoke("web_clipper_save_note", {
            requestId: request.requestId,
            vaultPathHint: request.vaultPathHint,
            vaultNameHint: request.vaultNameHint,
            title: request.title,
            folder: request.folder,
            content,
        });
        emitClipSaved(payload);
    })().catch((error) => {
        console.error(
            `[web-clipper-deep-link] ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    });
}

function startWebClipperServer() {
    if (serverStarted || !runtime) return;
    serverStarted = true;

    const server = http.createServer((request, response) => {
        void handleWebClipperRequest(request, response).catch((error) => {
            writeJson(response, 500, null, {
                ok: false,
                message: error instanceof Error ? error.message : String(error),
            });
        });
    });

    server.on("error", (error) => {
        serverStarted = false;
        console.error(`[web-clipper-api] ${error.message}`);
    });
    server.listen(WEB_CLIPPER_API_PORT, "127.0.0.1");
    app.once("before-quit", () => server.close());
    app.once("will-quit", () => server.close());
}

async function handleWebClipperRequest(
    request: IncomingMessage,
    response: ServerResponse,
) {
    const origin = headerValue(request, "origin");
    const extensionId = headerValue(request, CLIPPER_EXTENSION_ID_HEADER);
    const identity = resolveExtensionIdentity(origin, extensionId);

    if (request.method === "OPTIONS") {
        if (!identity.ok) {
            writeAuthError(response, identity);
            return;
        }
        writeJson(response, 204, identity.authorized.origin, { ok: true });
        return;
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/web-clipper/pair") {
        if (!identity.ok) {
            writeAuthError(response, identity);
            return;
        }
        const state = await pairWebClipper(identity.authorized);
        writeJson(response, 200, identity.authorized.origin, {
            ok: true,
            token: state.token,
        });
        return;
    }

    const authorized = await authorizeRequest(request, identity);
    if (!authorized.ok) {
        writeAuthError(response, authorized);
        return;
    }

    switch (`${request.method ?? "GET"} ${url.pathname}`) {
        case "GET /api/web-clipper/health": {
            const vaults = await runtime!.backend.invoke("web_clipper_ready_vaults", {});
            const vaultList = Array.isArray(vaults) ? vaults : [];
            writeJson(response, 200, authorized.authorized.origin, {
                ok: true,
                message:
                    vaultList.length === 0
                        ? "NeverWrite is running, but no vault is ready."
                        : "NeverWrite desktop API is ready.",
                vaults: vaultList,
            });
            return;
        }
        case "GET /api/web-clipper/themes":
            writeJson(response, 200, authorized.authorized.origin, {
                themes: [
                    { id: "default", label: "Default" },
                    { id: "ocean", label: "Ocean" },
                    { id: "forest", label: "Forest" },
                    { id: "rose", label: "Rose" },
                    { id: "amber", label: "Amber" },
                    { id: "lavender", label: "Lavender" },
                    { id: "nord", label: "Nord" },
                    { id: "sunset", label: "Sunset" },
                    { id: "catppuccin", label: "Catppuccin" },
                    { id: "solarized", label: "Solarized" },
                    { id: "tokyoNight", label: "Tokyo Night" },
                    { id: "gruvbox", label: "Gruvbox" },
                    { id: "ayu", label: "Ayu" },
                    { id: "nightOwl", label: "Night Owl" },
                    { id: "vesper", label: "Vesper" },
                    { id: "rosePine", label: "Rose Pine" },
                    { id: "kanagawa", label: "Kanagawa" },
                    { id: "everforest", label: "Everforest" },
                    { id: "synthwave84", label: "Synthwave 84" },
                    { id: "claude", label: "Claude" },
                    { id: "codex", label: "Codex" },
                ],
            });
            return;
        case "POST /api/web-clipper/folders": {
            const body = await readJsonBody(request);
            const folders = await runtime!.backend.invoke(
                "web_clipper_list_folders",
                asRecord(body),
            );
            writeJson(response, 200, authorized.authorized.origin, { folders });
            return;
        }
        case "POST /api/web-clipper/tags": {
            const body = await readJsonBody(request);
            const tags = await runtime!.backend.invoke(
                "web_clipper_list_tags",
                asRecord(body),
            );
            writeJson(response, 200, authorized.authorized.origin, { tags });
            return;
        }
        case "POST /api/web-clipper/clips": {
            const body = asRecord(await readJsonBody(request));
            if (!String(body.content ?? "").trim()) {
                writeJson(response, 400, authorized.authorized.origin, {
                    ok: false,
                    status: "error",
                    message: "Clip content is empty.",
                });
                return;
            }
            try {
                const payload = await runtime!.backend.invoke(
                    "web_clipper_save_note",
                    body,
                );
                emitClipSaved(payload);
                writeJson(response, 200, authorized.authorized.origin, {
                    ok: true,
                    status: "saved",
                    message: `Saved clip to ${asRecord(payload).relativePath}.`,
                    noteId: asRecord(payload).noteId,
                    relativePath: asRecord(payload).relativePath,
                });
            } catch (error) {
                writeJson(response, 400, authorized.authorized.origin, {
                    ok: false,
                    status: "error",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }
        default:
            writeJson(response, 404, authorized.authorized.origin, {
                ok: false,
                message: "Not found.",
            });
    }
}

function emitClipSaved(payload: unknown) {
    const targetWindowLabel = asRecord(payload).targetWindowLabel;
    runtime!.emitEvent(
        typeof targetWindowLabel === "string"
            ? WEB_CLIPPER_CLIP_SAVED_EVENT
            : WEB_CLIPPER_ROUTE_CLIP_EVENT,
        payload,
    );
}

function parseWebClipperDeepLink(rawUrl: string) {
    const url = new URL(rawUrl);
    if (url.protocol !== "neverwrite:" || url.hostname !== "clip") {
        throw new Error("Unsupported web clipper deep link.");
    }
    const requestId = requiredParam(url, "requestId");
    const title = requiredParam(url, "title");
    const folder = requiredParam(url, "folder");
    const mode = requiredParam(url, "mode");
    const vault = normalizeHint(url.searchParams.get("vault"));
    const vaultPathHint =
        normalizeHint(url.searchParams.get("vaultPathHint")) ??
        (vault && path.isAbsolute(vault) ? vault : null);
    const vaultNameHint =
        normalizeHint(url.searchParams.get("vaultNameHint")) ??
        (vault && !path.isAbsolute(vault) ? vault : null);

    if (mode !== "inline" && mode !== "clipboard") {
        throw new Error("Unsupported web clipper deep link mode.");
    }

    return {
        requestId,
        title,
        folder,
        mode,
        vaultPathHint,
        vaultNameHint,
        content: url.searchParams.get("content"),
    };
}

function requiredParam(url: URL, key: string) {
    const value = url.searchParams.get(key)?.trim();
    if (!value) throw new Error(`Missing web clipper deep link parameter: ${key}`);
    return value;
}

function normalizeHint(value: string | null) {
    let normalized = value?.trim();
    if (!normalized) return null;
    while (
        normalized.length >= 2 &&
        ((normalized.startsWith("'") && normalized.endsWith("'")) ||
            (normalized.startsWith('"') && normalized.endsWith('"')))
    ) {
        normalized = normalized.slice(1, -1).trim();
    }
    return normalized || null;
}

function resolveExtensionIdentity(
    origin: string | null,
    extensionId: string | null,
):
    | { ok: true; authorized: AuthorizedClipper }
    | { ok: false; statusCode: number; message: string } {
    const id = extensionId?.trim();
    if (!id) {
        return {
            ok: false,
            statusCode: 401,
            message: "Web clipper extension identity is required.",
        };
    }

    const allowedOrigins = new Set([
        `chrome-extension://${CHROME_EXTENSION_ID}`,
        `moz-extension://${FIREFOX_EXTENSION_ID}`,
        ...readDevOrigins(),
    ]);
    const resolvedOrigin =
        origin?.trim() ||
        (allowedOrigins.has(`chrome-extension://${id}`)
            ? `chrome-extension://${id}`
            : "");

    if (!resolvedOrigin) {
        return {
            ok: false,
            statusCode: 401,
            message: "Web clipper origin is required.",
        };
    }
    if (!isExtensionOrigin(resolvedOrigin)) {
        return {
            ok: false,
            statusCode: 403,
            message: "Web clipper origin is not allowed.",
        };
    }
    if (
        id === CHROME_EXTENSION_ID &&
        resolvedOrigin === `chrome-extension://${CHROME_EXTENSION_ID}`
    ) {
        return {
            ok: true,
            authorized: { origin: resolvedOrigin, identity: "official-chrome" },
        };
    }
    if (id === FIREFOX_EXTENSION_ID && resolvedOrigin.startsWith("moz-extension://")) {
        return {
            ok: true,
            authorized: { origin: resolvedOrigin, identity: "official-firefox" },
        };
    }
    if (allowedOrigins.has(resolvedOrigin)) {
        return {
            ok: true,
            authorized: { origin: resolvedOrigin, identity: "explicit-dev" },
        };
    }
    return {
        ok: false,
        statusCode: 403,
        message: "Web clipper extension is not allowed.",
    };
}

async function authorizeRequest(
    request: IncomingMessage,
    identity:
        | { ok: true; authorized: AuthorizedClipper }
        | { ok: false; statusCode: number; message: string },
) {
    if (!identity.ok) return identity;
    const token = headerValue(request, CLIPPER_TOKEN_HEADER);
    if (!token) {
        return {
            ok: false as const,
            statusCode: 401,
            message: "Web clipper pairing is required.",
        };
    }
    const state = await loadOrCreateAuthState();
    if (token !== state.token) {
        return {
            ok: false as const,
            statusCode: 403,
            message: "Web clipper token is invalid.",
        };
    }
    if (
        identity.authorized.identity === "official-firefox" &&
        state.firefoxOrigin !== identity.authorized.origin
    ) {
        return {
            ok: false as const,
            statusCode: 401,
            message: "Web clipper pairing is required.",
        };
    }
    return identity;
}

async function pairWebClipper(authorized: AuthorizedClipper) {
    const state = await loadOrCreateAuthState();
    if (
        authorized.identity === "official-firefox" &&
        state.firefoxOrigin !== authorized.origin
    ) {
        state.token = crypto.randomUUID();
        state.firefoxOrigin = authorized.origin;
        await writeAuthState(state);
    }
    return state;
}

async function loadOrCreateAuthState(): Promise<AuthState> {
    try {
        return JSON.parse(await fs.readFile(authFilePath(), "utf8")) as AuthState;
    } catch {
        const state = { token: crypto.randomUUID(), firefoxOrigin: null };
        await writeAuthState(state);
        return state;
    }
}

async function writeAuthState(state: AuthState) {
    const filePath = authFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(state), "utf8");
}

function authFilePath() {
    return path.join(app.getPath("userData"), WEB_CLIPPER_AUTH_FILE);
}

function readDevOrigins() {
    const raw =
        process.env.NEVERWRITE_WEB_CLIPPER_DEV_ORIGINS ??
        process.env.WEB_CLIPPER_DEV_ORIGINS ??
        "";
    return raw
        .split(/[,;\n]/)
        .map((value) => value.trim())
        .filter(isExtensionOrigin);
}

function isExtensionOrigin(origin: string) {
    return (
        origin.startsWith("chrome-extension://") ||
        origin.startsWith("moz-extension://")
    );
}

function headerValue(request: IncomingMessage, header: string) {
    const value = request.headers[header.toLowerCase()];
    return Array.isArray(value) ? value[0] ?? null : value?.trim() || null;
}

async function readJsonBody(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    return body.trim() ? JSON.parse(body) : {};
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
}

function writeAuthError(
    response: ServerResponse,
    error: { statusCode: number; message: string },
) {
    writeJson(response, error.statusCode, null, {
        ok: false,
        status: "unauthorized",
        message: error.message,
    });
}

function writeJson(
    response: ServerResponse,
    statusCode: number,
    origin: string | null,
    body: unknown,
) {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json");
    if (origin) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("vary", "Origin");
        response.setHeader(
            "access-control-allow-headers",
            `${CLIPPER_TOKEN_HEADER}, ${CLIPPER_EXTENSION_ID_HEADER}, content-type`,
        );
        response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    }
    response.end(statusCode === 204 ? undefined : JSON.stringify(body));
}
