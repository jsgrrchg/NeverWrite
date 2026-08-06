import { formatShortcutAction } from "../../app/shortcuts/format";
import type { ShortcutActionId } from "../../app/shortcuts/registry";
import { getDesktopPlatform } from "../../app/utils/platform";

interface WorkspacePaneEmptyStateProps {
    paneId: string;
}

// Resolve the binding from the shortcut registry at render time so the hint
// stays accurate if the user rebinds an action, and so the platform modifier
// (⌘ vs Ctrl) is correct per OS.
function ShortcutHint({ action }: { action: ShortcutActionId }) {
    const label = formatShortcutAction(action, getDesktopPlatform());
    if (!label) return null;
    return (
        <kbd
            className="ml-1 rounded px-1.5 py-0.5 text-xs font-medium"
            style={{
                color: "var(--text-primary)",
                background: "var(--bg-tertiary)",
                border: "1px solid color-mix(in srgb, var(--border) 80%, transparent)",
                fontFamily: "inherit",
                whiteSpace: "nowrap",
            }}
        >
            {label}
        </kbd>
    );
}

export function WorkspacePaneEmptyState({
    paneId,
}: WorkspacePaneEmptyStateProps) {
    return (
        <div
            className="flex h-full items-center justify-center p-6"
            data-workspace-empty-pane={paneId}
        >
            <p
                className="max-w-md text-center text-sm leading-8"
                style={{ color: "var(--text-secondary)" }}
            >
                Open a file
                <ShortcutHint action="quick_switcher" />, browse commands
                <ShortcutHint action="command_palette" />, start a chat
                <ShortcutHint action="new_agent" />, or launch a terminal
                <ShortcutHint action="new_terminal" />.
            </p>
        </div>
    );
}
