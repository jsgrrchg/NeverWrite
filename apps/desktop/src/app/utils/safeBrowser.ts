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

    // Hardened desktop builds run from a custom app protocol and must not
    // probe dynamic code support with `new Function()`, because that probe
    // itself is blocked by CSP. Keep the rule explicit and side-effect free.
    dynamicFunctionSupport =
        import.meta.env.DEV || protocol === "http:" || protocol === "https:";

    return dynamicFunctionSupport;
}

export function canUseExcalidrawRuntime() {
    return canUseDynamicFunction();
}
