export type SaveButtonStatus = "idle" | "sending" | "sent" | "error";

interface SaveButtonProps {
    disabled?: boolean;
    status?: SaveButtonStatus;
    onClick?: () => void;
}

function buttonLabel(status: SaveButtonStatus): string {
    switch (status) {
        case "sending":
            return "Saving...";
        case "sent":
            return "Saved";
        case "error":
            return "Retry";
        default:
            return "Save";
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
            className="inline-flex items-center justify-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-xs font-semibold text-white shadow-soft transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
        >
            <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
                <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
                <path d="M7 3v4a1 1 0 0 0 1 1h7" />
            </svg>
            {buttonLabel(status)}
        </button>
    );
}

export default SaveButton;
