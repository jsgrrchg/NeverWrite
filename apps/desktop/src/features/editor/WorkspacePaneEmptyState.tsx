interface WorkspacePaneEmptyStateProps {
    paneId: string;
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
                className="max-w-md text-center text-sm leading-6"
                style={{ color: "var(--text-secondary)" }}
            >
                Open a file, start a chat or launch a terminal.
            </p>
        </div>
    );
}
