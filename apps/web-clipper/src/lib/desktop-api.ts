import {
    clearDesktopClipperToken,
    loadDesktopClipperToken,
    saveDesktopClipperToken,
} from "./storage";

export const DESKTOP_API_PORT = 32145;
const DESKTOP_API_BASE = `http://127.0.0.1:${DESKTOP_API_PORT}/api/web-clipper`;
const REQUEST_TIMEOUT_MS = 1200;
const CLIPPER_TOKEN_HEADER = "x-vaultai-clipper-token";
const CLIPPER_EXTENSION_ID_HEADER = "x-vaultai-extension-id";
let pairingPromise: Promise<string> | null = null;

export interface DesktopLookupInput {
    vaultPathHint?: string;
    vaultNameHint?: string;
}

export interface DesktopContextPayload {
    available: boolean;
    folders: string[];
    tags: string[];
    themes: Array<{ id: string; label: string }>;
    statusMessage: string;
}

export interface DesktopClipSaveInput extends DesktopLookupInput {
    requestId: string;
    title: string;
    content: string;
    folder: string;
    tags?: string[];
    sourceUrl?: string;
}

export interface DesktopClipSaveResponse {
    ok: boolean;
    status: "saved" | "error";
    message: string;
    noteId?: string;
    relativePath?: string;
}

interface DesktopPairingResponse {
    ok: boolean;
    token: string;
}

type DesktopApiErrorKind = "request" | "unauthorized" | "unavailable";

class DesktopApiError extends Error {
    constructor(
        message: string,
        public readonly kind: DesktopApiErrorKind,
        public readonly statusCode?: number,
    ) {
        super(message);
    }

    get isUnavailable(): boolean {
        return this.kind === "unavailable";
    }

    get isUnauthorized(): boolean {
        return this.kind === "unauthorized";
    }
}

function getExtensionId(): string {
    return browser.runtime.id;
}

function buildDesktopApiHeadersWithAuth(
    extensionId: string,
    token: string | null,
): HeadersInit {
    return {
        "content-type": "application/json",
        [CLIPPER_EXTENSION_ID_HEADER]: extensionId,
        ...(token ? { [CLIPPER_TOKEN_HEADER]: token } : {}),
    };
}

async function fetchDesktopApiResponse(
    path: string,
    method: "GET" | "POST",
    extensionId: string,
    token: string | null,
    body?: unknown,
): Promise<Response> {
    const controller = new AbortController();
    const timeout = window.setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
    );

    try {
        return await fetch(`${DESKTOP_API_BASE}${path}`, {
            method,
            headers: buildDesktopApiHeadersWithAuth(extensionId, token),
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
    } catch (error) {
        if (error instanceof DesktopApiError) {
            throw error;
        }

        throw new DesktopApiError(
            "VaultAI desktop API is unavailable.",
            "unavailable",
        );
    } finally {
        window.clearTimeout(timeout);
    }
}

async function pairDesktopApi(extensionId: string): Promise<string> {
    if (pairingPromise !== null) {
        return pairingPromise;
    }

    pairingPromise = (async () => {
        const response = await fetchDesktopApiResponse(
            "/pair",
            "GET",
            extensionId,
            null,
        );
        if (!response.ok) {
            const message =
                (await response.json().catch(() => null))?.message ??
                `Desktop API request failed with ${response.status}.`;
            throw new DesktopApiError(message, "unauthorized", response.status);
        }

        const payload = (await response.json()) as DesktopPairingResponse;
        if (!payload.token?.trim()) {
            throw new DesktopApiError(
                "VaultAI desktop API did not return a valid pairing token.",
                "unauthorized",
                response.status,
            );
        }
        await saveDesktopClipperToken(payload.token);
        return payload.token;
    })();

    try {
        return await pairingPromise;
    } finally {
        pairingPromise = null;
    }
}

async function requestJson<T>(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
): Promise<T> {
    const extensionId = getExtensionId();
    let token = await loadDesktopClipperToken();
    try {
        let response = await fetchDesktopApiResponse(
            path,
            method,
            extensionId,
            token,
            body,
        );

        if ((response.status === 401 || response.status === 403) && token) {
            await clearDesktopClipperToken();
            token = null;
            response = await fetchDesktopApiResponse(
                path,
                method,
                extensionId,
                token,
                body,
            );
        }

        if ((response.status === 401 || response.status === 403) && !token) {
            token = await pairDesktopApi(extensionId);
            response = await fetchDesktopApiResponse(
                path,
                method,
                extensionId,
                token,
                body,
            );
        }

        if (!response.ok) {
            const message =
                (await response.json().catch(() => null))?.message ??
                `Desktop API request failed with ${response.status}.`;
            throw new DesktopApiError(
                message,
                response.status === 401 || response.status === 403
                    ? "unauthorized"
                    : "request",
                response.status,
            );
        }

        return (await response.json()) as T;
    } catch (error) {
        if (error instanceof DesktopApiError) {
            throw error;
        }

        throw new DesktopApiError(
            "VaultAI desktop API is unavailable.",
            "unavailable",
        );
    }
}

export async function fetchDesktopContext(
    input: DesktopLookupInput,
): Promise<DesktopContextPayload> {
    const [health, folders, tags, themes] = await Promise.all([
        requestJson<{
            ok: boolean;
            message: string;
        }>("/health", "GET"),
        requestJson<{ folders: string[] }>("/folders", "POST", input),
        requestJson<{ tags: string[] }>("/tags", "POST", input),
        requestJson<{ themes: Array<{ id: string; label: string }> }>(
            "/themes",
            "GET",
        ),
    ]);

    return {
        available: Boolean(health.ok),
        folders: folders.folders,
        tags: tags.tags,
        themes: themes.themes,
        statusMessage: health.message,
    };
}

export async function saveClipToDesktop(
    input: DesktopClipSaveInput,
): Promise<DesktopClipSaveResponse> {
    return requestJson<DesktopClipSaveResponse>("/clips", "POST", input);
}

export { DesktopApiError };
