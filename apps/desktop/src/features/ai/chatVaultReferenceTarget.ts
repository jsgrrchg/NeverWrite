export interface ChatVaultReferenceTarget {
    path: string;
    line: number | null;
    endLine: number | null;
}

const LINE_SUFFIX_RE =
    /^(.*?)(?:#L([1-9]\d*)(?:-L?([1-9]\d*))?|:([1-9]\d*)(?:-([1-9]\d*))?)$/i;

export function parseChatVaultReferenceTarget(
    reference: string,
): ChatVaultReferenceTarget {
    const trimmed = reference.trim();
    const match = LINE_SUFFIX_RE.exec(trimmed);
    if (!match?.[1]?.trim()) {
        return { path: trimmed, line: null, endLine: null };
    }

    const line = Number(match[2] ?? match[4]);
    const parsedEndLine = match[3] ?? match[5];
    return {
        path: match[1].trim(),
        line,
        endLine: parsedEndLine ? Number(parsedEndLine) : null,
    };
}

export function serializeChatVaultReferenceTarget(
    target: ChatVaultReferenceTarget,
) {
    if (!target.line) return target.path;
    const range =
        target.endLine && target.endLine !== target.line
            ? `-${target.endLine}`
            : "";
    return `${target.path}#L${target.line}${range}`;
}

export function getChatVaultReferenceLabel(
    label: string,
    target: Pick<ChatVaultReferenceTarget, "line" | "endLine">,
) {
    if (!target.line) return label;
    if (/\s+\((?:line|lines)\s+\d+(?:\s*[-–:]\s*\d+)?\)$/i.test(label)) {
        return label;
    }
    return target.endLine && target.endLine !== target.line
        ? `${label} (lines ${target.line}–${target.endLine})`
        : `${label} (line ${target.line})`;
}

export function getChatVaultReferenceBasename(path: string) {
    return path.replace(/\\/g, "/").split("/").at(-1) || path;
}
