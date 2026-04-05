export function readSearchParam(name: string): string | null {
    if (typeof window === "undefined") return null;

    try {
        return new URLSearchParams(window.location.search).get(name);
    } catch {
        return null;
    }
}

export function safeMatchMedia(query: string): MediaQueryList | null {
    if (typeof window === "undefined") return null;
    if (typeof window.matchMedia !== "function") return null;

    try {
        return window.matchMedia(query);
    } catch {
        return null;
    }
}

export function safeMatchMediaMatches(query: string, fallback = false) {
    return safeMatchMedia(query)?.matches ?? fallback;
}

export function applyGhostWindowDocumentState() {
    if (typeof document === "undefined") return;
    if (readSearchParam("window") !== "ghost") return;

    document.documentElement.style.setProperty(
        "background",
        "transparent",
        "important",
    );
    document.body.style.setProperty("background", "transparent", "important");
}

let dynamicFunctionSupport: boolean | null = null;

function getLocationProtocol() {
    if (typeof window === "undefined") return null;

    try {
        return window.location.protocol;
    } catch {
        return null;
    }
}

export function canUseDynamicFunction() {
    if (dynamicFunctionSupport !== null) {
        return dynamicFunctionSupport;
    }

    const protocol = getLocationProtocol();

    if (protocol === "http:" || protocol === "https:") {
        dynamicFunctionSupport = true;
        return dynamicFunctionSupport;
    }

    try {
        // Desktop builds may run from a custom app protocol, so protocol-based
        // detection is too strict for features like Excalidraw.
        dynamicFunctionSupport = Boolean(new Function("return true")());
    } catch {
        dynamicFunctionSupport = false;
    }

    return dynamicFunctionSupport;
}

export function canUseExcalidrawRuntime() {
    return canUseDynamicFunction();
}
