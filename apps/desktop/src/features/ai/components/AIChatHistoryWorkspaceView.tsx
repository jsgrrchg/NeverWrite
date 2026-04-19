export function AIChatHistoryWorkspaceView() {
    return (
        <div
            data-testid="ai-chat-history-workspace-view"
            className="h-full flex items-center justify-center p-6"
            style={{ color: "var(--text-secondary)" }}
        >
            <div
                className="max-w-xl rounded-xl p-5"
                style={{
                    border: "1px solid var(--border)",
                    background: "var(--bg-secondary)",
                }}
            >
                <div
                    className="text-sm font-semibold"
                    style={{ color: "var(--text-primary)" }}
                >
                    Chat History
                </div>
                <div className="mt-2 text-sm leading-6">
                    This workspace tab is ready for the dedicated history
                    browser. The richer sidebar-and-transcript experience will
                    be mounted here in the next step.
                </div>
            </div>
        </div>
    );
}
