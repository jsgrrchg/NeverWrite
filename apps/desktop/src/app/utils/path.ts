export function getPathBaseName(path: string): string {
    const normalized = path.replace(/[\\/]+$/, "");
    if (!normalized) return path;

    const parts = normalized.split(/[/\\]/);
    return parts[parts.length - 1] ?? normalized;
}
