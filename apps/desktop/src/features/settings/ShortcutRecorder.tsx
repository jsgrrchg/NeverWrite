import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
    ShortcutBinding,
    ShortcutModifier,
} from "../../app/shortcuts/registry";
import type { DesktopPlatform } from "../../app/utils/platform";
import { getReservedInteractionShortcut } from "../../app/shortcuts/reservedInteractions";
import { AltGraphTracker } from "../../app/shortcuts/altGraph";

const MODIFIER_KEYS = new Set([
    "alt",
    "altgraph",
    "capslock",
    "control",
    "meta",
    "numlock",
    "os",
    "scrolllock",
    "shift",
]);

const UNUSABLE_KEYS = new Set(["compose", "dead", "process", "unidentified"]);

type ShortcutCaptureResult =
    | { kind: "binding"; binding: ShortcutBinding }
    | { kind: "cancel" }
    | { kind: "navigate" }
    | { kind: "error"; message: string };

function getEventModifiers(event: KeyboardEvent): ShortcutModifier[] {
    const modifiers: ShortcutModifier[] = [];
    if (event.metaKey) modifiers.push("meta");
    if (event.ctrlKey) modifiers.push("ctrl");
    if (event.altKey) modifiers.push("alt");
    if (event.shiftKey) modifiers.push("shift");
    return modifiers;
}

function hasExactly(
    modifiers: readonly ShortcutModifier[],
    expected: readonly ShortcutModifier[],
) {
    return (
        modifiers.length === expected.length &&
        expected.every((modifier) => modifiers.includes(modifier))
    );
}

function isReservedShortcut(
    binding: ShortcutBinding,
    platform: DesktopPlatform,
) {
    const key = binding.key.toLowerCase();
    const modifiers = binding.modifiers ?? [];

    if (platform === "macos") {
        return (
            (["h", "m", "q", "space", "tab"].includes(key) &&
                hasExactly(modifiers, ["meta"])) ||
            (key === "q" && hasExactly(modifiers, ["meta", "ctrl"]))
        );
    }

    return (
        (key === "f4" && hasExactly(modifiers, ["alt"])) ||
        (key === "tab" && hasExactly(modifiers, ["alt"])) ||
        (["d", "l", "tab"].includes(key) &&
            hasExactly(modifiers, ["meta"])) ||
        (key === "delete" && hasExactly(modifiers, ["ctrl", "alt"]))
    );
}

function captureShortcutBinding(
    event: KeyboardEvent,
    platform: DesktopPlatform,
): ShortcutCaptureResult {
    const normalizedKey = event.key.toLowerCase();
    const modifiers = getEventModifiers(event);

    if (normalizedKey === "escape") {
        return { kind: "cancel" };
    }
    if (
        normalizedKey === "tab" &&
        (modifiers.length === 0 || hasExactly(modifiers, ["shift"]))
    ) {
        return { kind: "navigate" };
    }
    if (MODIFIER_KEYS.has(normalizedKey)) {
        return {
            kind: "error",
            message: "Press a non-modifier key to complete the shortcut.",
        };
    }
    if (modifiers.length === 0) {
        return {
            kind: "error",
            message: "Include at least one modifier key.",
        };
    }
    if (UNUSABLE_KEYS.has(normalizedKey)) {
        return {
            kind: "error",
            message: "This key cannot be used as a global shortcut.",
        };
    }

    const binding: ShortcutBinding = {
        key: event.key === " " ? "Space" : event.key,
        modifiers,
    };
    if (isReservedShortcut(binding, platform)) {
        return {
            kind: "error",
            message: "This shortcut is reserved by the operating system.",
        };
    }
    const reservedInteraction = getReservedInteractionShortcut(
        binding,
        platform,
    );
    if (reservedInteraction) {
        return {
            kind: "error",
            message: `This shortcut is reserved for ${reservedInteraction.label} and cannot be reassigned.`,
        };
    }
    return { kind: "binding", binding };
}

export function ShortcutRecorder({
    actionLabel,
    platform,
    onRecord,
}: {
    actionLabel: string;
    platform: DesktopPlatform;
    onRecord: (binding: ShortcutBinding) => void;
}) {
    const buttonRef = useRef<HTMLButtonElement>(null);
    const altGraphTrackerRef = useRef<AltGraphTracker | null>(null);
    altGraphTrackerRef.current ??= new AltGraphTracker();
    const [recording, setRecording] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const statusId = `shortcut-recorder-${actionLabel
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")}`;

    const stopRecording = () => {
        altGraphTrackerRef.current?.reset();
        setRecording(false);
        setError(null);
    };

    const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
        if (!recording) return;

        if (
            altGraphTrackerRef.current?.shouldIgnoreKeyDown(
                event.nativeEvent,
                platform,
            )
        ) {
            event.preventDefault();
            event.stopPropagation();
            setError(
                "AltGr combinations cannot be used as global shortcuts.",
            );
            return;
        }
        if (event.repeat) return;

        const result = captureShortcutBinding(event.nativeEvent, platform);
        if (result.kind === "navigate") {
            stopRecording();
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        if (result.kind === "cancel") {
            stopRecording();
            return;
        }
        if (result.kind === "error") {
            setError(result.message);
            return;
        }

        stopRecording();
        buttonRef.current?.focus();
        onRecord(result.binding);
    };

    return (
        <div style={{ position: "relative" }}>
            <button
                ref={buttonRef}
                type="button"
                aria-label={`${recording ? "Cancel recording" : "Record shortcut"} for ${actionLabel}`}
                aria-describedby={recording || error ? statusId : undefined}
                aria-pressed={recording}
                onClick={() => {
                    if (recording) {
                        stopRecording();
                    } else {
                        setError(null);
                        setRecording(true);
                    }
                }}
                onBlur={() => {
                    if (recording) stopRecording();
                }}
                onKeyDown={handleKeyDown}
                onKeyUp={(event) =>
                    altGraphTrackerRef.current?.handleKeyUp(
                        event.nativeEvent,
                        platform,
                    )
                }
                style={{
                    minWidth: 108,
                    padding: "4px 8px",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    backgroundColor: recording
                        ? "color-mix(in srgb, var(--accent) 15%, var(--bg-tertiary))"
                        : "var(--bg-tertiary)",
                    color: recording ? "var(--accent)" : "var(--text-primary)",
                    fontFamily: "inherit",
                    fontSize: 11,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                }}
            >
                {recording ? "Press shortcut…" : "Record shortcut"}
            </button>
            {(recording || error) && (
                <span
                    id={statusId}
                    role={error ? "alert" : "status"}
                    style={{
                        position: "absolute",
                        top: "calc(100% + 4px)",
                        right: 0,
                        zIndex: 2,
                        width: 220,
                        padding: "5px 7px",
                        border: "1px solid var(--border)",
                        borderRadius: 5,
                        backgroundColor: "var(--bg-secondary)",
                        boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
                        color: error ? "#ef4444" : "var(--text-secondary)",
                        fontSize: 10,
                        lineHeight: 1.4,
                    }}
                >
                    {error ?? "Press a modified key. Escape cancels."}
                </span>
            )}
        </div>
    );
}
