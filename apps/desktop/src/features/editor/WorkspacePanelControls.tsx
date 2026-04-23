import {
    chromeControlsGroupStyle,
    getChromeIconButtonStyle,
} from "./workspaceChromeControls";

interface WorkspacePanelControlsProps {
    rightPanelCollapsed: boolean;
    rightPanelView: "links" | "outline";
    activateRightView: (view: "links" | "outline") => void;
}

export function WorkspacePanelControls({
    rightPanelCollapsed,
    rightPanelView,
    activateRightView,
}: WorkspacePanelControlsProps) {
    return (
        <div style={chromeControlsGroupStyle}>
            <button
                type="button"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => activateRightView("outline")}
                title="Outline panel"
                className="no-drag flex items-center justify-center shrink-0 ub-chrome-btn"
                data-active={
                    (!rightPanelCollapsed && rightPanelView === "outline") ||
                    undefined
                }
                style={getChromeIconButtonStyle(
                    !rightPanelCollapsed && rightPanelView === "outline",
                )}
            >
                <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <path d="M3 3.5h10" />
                    <path d="M5.5 8h7.5" />
                    <path d="M8 12.5h5" />
                    <path d="M3 8h.01" />
                    <path d="M5.5 12.5h.01" />
                </svg>
            </button>
            <button
                type="button"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => activateRightView("links")}
                title="Links panel"
                className="no-drag flex items-center justify-center shrink-0 ub-chrome-btn"
                data-active={
                    (!rightPanelCollapsed && rightPanelView === "links") ||
                    undefined
                }
                style={getChromeIconButtonStyle(
                    !rightPanelCollapsed && rightPanelView === "links",
                )}
            >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <rect
                        x="11"
                        y="2"
                        width="4"
                        height="12"
                        rx="1"
                        fill="currentColor"
                    />
                    <rect
                        x="1"
                        y="2"
                        width="8"
                        height="2"
                        rx="1"
                        fill="currentColor"
                    />
                    <rect
                        x="1"
                        y="7"
                        width="8"
                        height="2"
                        rx="1"
                        fill="currentColor"
                    />
                    <rect
                        x="1"
                        y="12"
                        width="8"
                        height="2"
                        rx="1"
                        fill="currentColor"
                    />
                </svg>
            </button>
        </div>
    );
}
