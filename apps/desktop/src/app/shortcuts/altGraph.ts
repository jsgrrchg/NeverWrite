import type { DesktopPlatform } from "../utils/platform";

interface AltGraphKeyboardEvent {
    key: string;
    code?: string;
    ctrlKey: boolean;
    altKey: boolean;
    getModifierState?: (keyArg: string) => boolean;
}

function reportsAltGraph(event: AltGraphKeyboardEvent) {
    try {
        return event.getModifierState?.("AltGraph") === true;
    } catch {
        return false;
    }
}

function isAltGraphPress(event: AltGraphKeyboardEvent) {
    return (
        event.key.toLowerCase() === "altgraph" ||
        reportsAltGraph(event) ||
        (event.code === "AltRight" && event.ctrlKey && event.altKey)
    );
}

function isAltGraphRelease(event: AltGraphKeyboardEvent) {
    return (
        event.key.toLowerCase() === "altgraph" || event.code === "AltRight"
    );
}

export class AltGraphTracker {
    private active = false;

    shouldIgnoreKeyDown(
        event: AltGraphKeyboardEvent,
        platform: DesktopPlatform,
    ) {
        if (platform === "macos") {
            this.active = false;
            return false;
        }
        if (isAltGraphPress(event)) {
            this.active = true;
        }
        return this.active;
    }

    handleKeyUp(event: AltGraphKeyboardEvent, platform: DesktopPlatform) {
        if (platform === "macos" || isAltGraphRelease(event)) {
            this.active = false;
        }
    }

    reset() {
        this.active = false;
    }
}
