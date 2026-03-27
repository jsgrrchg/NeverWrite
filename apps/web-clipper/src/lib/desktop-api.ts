export const DESKTOP_API_PORT = 32145;
const DESKTOP_API_BASE = `http://127.0.0.1:${DESKTOP_API_PORT}/api/web-clipper`;
const REQUEST_TIMEOUT_MS = 1200;

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

class DesktopApiError extends Error {
    constructor(
        message: string,
        public readonly isUnavailable = false,
    ) {
        super(message);
    }
}

async function requestJson<T>(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
): Promise<T> {
    const controller = new AbortController();
    const timeout = window.setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
    );

    try {
        const response = await fetch(`${DESKTOP_API_BASE}${path}`, {
            method,
            headers: {
                "content-type": "application/json",
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });

        if (!response.ok) {
            const message =
                (await response.json().catch(() => null))?.message ??
                `Desktop API request failed with ${response.status}.`;
            throw new DesktopApiError(message, false);
        }

        return (await response.json()) as T;
    } catch (error) {
        if (error instanceof DesktopApiError) {
            throw error;
        }

        throw new DesktopApiError("VaultAI desktop API is unavailable.", true);
    } finally {
        window.clearTimeout(timeout);
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
