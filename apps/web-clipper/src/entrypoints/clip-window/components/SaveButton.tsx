export type SaveButtonStatus = "idle" | "sending" | "sent" | "error";

interface SaveButtonProps {
    disabled?: boolean;
    status?: SaveButtonStatus;
    onClick?: () => void;
}

function buttonLabel(status: SaveButtonStatus): string {
    switch (status) {
        case "sending":
            return "Sending to VaultAI...";
        case "sent":
            return "Continue in VaultAI";
        case "error":
            return "Retry VaultAI Handoff";
        default:
            return "Save to VaultAI";
    }
}

export function SaveButton({
    disabled = false,
    status = "idle",
    onClick,
}: SaveButtonProps) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className="inline-flex h-11 items-center justify-center rounded-[10px] border border-accent/30 bg-accent/15 px-5 text-sm font-semibold text-fg transition hover:bg-accent/22 disabled:cursor-not-allowed disabled:border-edge disabled:bg-surface-raised disabled:text-fg-muted"
        >
            {buttonLabel(status)}
        </button>
    );
}

export default SaveButton;
