import { useMemo } from "react";
import type { TerminalTab } from "../../app/store/editorStore";
import { TerminalViewport } from "../devtools/terminal/TerminalViewport";
import {
    createTerminalSessionView,
    useTerminalRuntimeStore,
} from "./terminalRuntimeStore";

interface WorkspaceTerminalViewProps {
    tab: TerminalTab;
    active: boolean;
    activePane: boolean;
}

export function WorkspaceTerminalView({
    tab,
    active,
    activePane,
}: WorkspaceTerminalViewProps) {
    const runtime = useTerminalRuntimeStore(
        (state) => state.runtimesById[tab.terminalId] ?? null,
    );
    const session = useMemo(
        () => (runtime ? createTerminalSessionView(runtime) : null),
        [runtime],
    );

    return (
        <div
            className="absolute inset-0 min-h-0 min-w-0"
            style={{
                visibility: active ? "visible" : "hidden",
                pointerEvents: active ? "auto" : "none",
            }}
            aria-hidden={!active}
            data-testid="workspace-terminal-view"
            data-terminal-id={tab.terminalId}
            data-terminal-active={active || undefined}
        >
            {session ? (
                <TerminalViewport
                    active={active}
                    autoFocus={active && activePane}
                    session={session}
                />
            ) : (
                <div
                    className="flex h-full items-center justify-center text-xs"
                    style={{
                        backgroundColor: "var(--terminal-bg, #09090b)",
                        color: "var(--text-secondary)",
                    }}
                >
                    Starting shell...
                </div>
            )}
        </div>
    );
}
