const MAX_RAW_OUTPUT_CHARS = 400_000;
const MAX_PERSISTED_RAW_OUTPUT_CHARS = 120_000;

function trimTerminalRawOutput(value: string, limit: number) {
    if (value.length <= limit) {
        return value;
    }

    return value.slice(value.length - limit);
}

export function appendTerminalRawOutput(current: string, chunk: string) {
    if (!chunk) {
        return current;
    }

    return trimTerminalRawOutput(current + chunk, MAX_RAW_OUTPUT_CHARS);
}

export function normalizePersistedTerminalRawOutput(value: string | null) {
    if (!value) {
        return "";
    }

    return trimTerminalRawOutput(value, MAX_PERSISTED_RAW_OUTPUT_CHARS);
}
