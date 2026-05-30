import { useEffect, useState } from "react";
import {
    AGENT_SIDEBAR_DRAG_EVENT,
    type AgentSidebarDragDetail,
} from "../ai/agentSidebarDragEvents";
import {
    FILE_TREE_NOTE_DRAG_EVENT,
    type FileTreeNoteDragDetail,
} from "../ai/dragEvents";

function isActiveDragPhase(phase: FileTreeNoteDragDetail["phase"]) {
    return phase === "start" || phase === "move";
}

export function useInternalDragIframeShield() {
    const [active, setActive] = useState(false);

    useEffect(() => {
        // HTML previews run in iframes, which can swallow window-level drag
        // events. Make the frame inert while an internal sidebar drag is active.
        const setShieldActive = (nextActive: boolean) => {
            setActive((current) =>
                current === nextActive ? current : nextActive,
            );
        };

        const handleFileTreeDrag = (event: Event) => {
            const detail = (event as CustomEvent<FileTreeNoteDragDetail>)
                .detail;
            if (!detail || detail.origin?.kind === "workspace-tab") {
                return;
            }

            setShieldActive(isActiveDragPhase(detail.phase));
        };

        const handleAgentSidebarDrag = (event: Event) => {
            const detail = (event as CustomEvent<AgentSidebarDragDetail>)
                .detail;
            if (!detail) return;

            setShieldActive(isActiveDragPhase(detail.phase));
        };

        const releaseShield = () => setShieldActive(false);

        window.addEventListener(FILE_TREE_NOTE_DRAG_EVENT, handleFileTreeDrag);
        window.addEventListener(
            AGENT_SIDEBAR_DRAG_EVENT,
            handleAgentSidebarDrag,
        );
        window.addEventListener("mouseup", releaseShield, true);
        window.addEventListener("pointerup", releaseShield, true);
        window.addEventListener("pointercancel", releaseShield, true);
        window.addEventListener("dragend", releaseShield, true);
        window.addEventListener("blur", releaseShield);

        return () => {
            window.removeEventListener(
                FILE_TREE_NOTE_DRAG_EVENT,
                handleFileTreeDrag,
            );
            window.removeEventListener(
                AGENT_SIDEBAR_DRAG_EVENT,
                handleAgentSidebarDrag,
            );
            window.removeEventListener("mouseup", releaseShield, true);
            window.removeEventListener("pointerup", releaseShield, true);
            window.removeEventListener("pointercancel", releaseShield, true);
            window.removeEventListener("dragend", releaseShield, true);
            window.removeEventListener("blur", releaseShield);
        };
    }, []);

    return active;
}
