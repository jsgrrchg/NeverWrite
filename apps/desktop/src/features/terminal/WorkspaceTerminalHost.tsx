import { listen } from "../../app/runtime";
import {
    isTerminalTab,
    selectEditorWorkspaceTabs,
    type TerminalTab,
    useEditorStore,
} from "../../app/store/editorStore";
import {
    DEV_TERMINAL_ERROR_EVENT,
    DEV_TERMINAL_EXITED_EVENT,
    DEV_TERMINAL_OUTPUT_EVENT,
    DEV_TERMINAL_STARTED_EVENT,
    type TerminalErrorEventPayload,
    type TerminalOutputEventPayload,
    type TerminalSessionSnapshot,
} from "../devtools/terminal/terminalTypes";
import { useTerminalRuntimeStore } from "./terminalRuntimeStore";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";

export function WorkspaceTerminalHost() {
    const terminalTabs = useEditorStore(
        useShallow((state) =>
            selectEditorWorkspaceTabs(state)
                .filter((tab): tab is TerminalTab => isTerminalTab(tab))
        ),
    );
    const ensureTerminal = useTerminalRuntimeStore(
        (state) => state.ensureTerminal,
    );
    const closeMissingTerminals = useTerminalRuntimeStore(
        (state) => state.closeMissingTerminals,
    );

    useEffect(() => {
        let cancelled = false;
        const detachPromise = Promise.all([
            listen<TerminalOutputEventPayload>(
                DEV_TERMINAL_OUTPUT_EVENT,
                (event) => {
                    if (cancelled) return;
                    useTerminalRuntimeStore
                        .getState()
                        .handleTerminalOutput(event.payload);
                },
            ),
            listen<TerminalSessionSnapshot>(
                DEV_TERMINAL_STARTED_EVENT,
                (event) => {
                    if (cancelled) return;
                    useTerminalRuntimeStore
                        .getState()
                        .handleTerminalStarted(event.payload);
                },
            ),
            listen<TerminalSessionSnapshot>(
                DEV_TERMINAL_EXITED_EVENT,
                (event) => {
                    if (cancelled) return;
                    useTerminalRuntimeStore
                        .getState()
                        .handleTerminalExited(event.payload);
                },
            ),
            listen<TerminalErrorEventPayload>(
                DEV_TERMINAL_ERROR_EVENT,
                (event) => {
                    if (cancelled) return;
                    useTerminalRuntimeStore
                        .getState()
                        .handleTerminalError(event.payload);
                },
            ),
        ]);

        return () => {
            cancelled = true;
            void detachPromise.then((listeners) => {
                for (const unlisten of listeners) {
                    unlisten();
                }
            });
        };
    }, []);

    useEffect(() => {
        for (const tab of terminalTabs) {
            ensureTerminal(tab);
        }
        closeMissingTerminals(terminalTabs.map((tab) => tab.terminalId));
    }, [closeMissingTerminals, ensureTerminal, terminalTabs]);

    useEffect(
        () => () => {
            useTerminalRuntimeStore.getState().closeMissingTerminals([]);
        },
        [],
    );

    return null;
}
