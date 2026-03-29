export function normalizeVaultPath(path: string) {
    return path.replace(/\\/g, "/");
}

export function isAbsoluteVaultPath(path: string) {
    const normalized = normalizeVaultPath(path);
    return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
}

export function normalizeVaultRoot(vaultPath: string | null) {
    if (!vaultPath) {
        return null;
    }

    return normalizeVaultPath(vaultPath).replace(/\/+$/, "");
}

export function resolveVaultAbsolutePath(
    path: string,
    vaultPath: string | null,
) {
    const normalizedPath = normalizeVaultPath(path);
    if (isAbsoluteVaultPath(normalizedPath)) {
        return normalizedPath;
    }

    const normalizedVaultPath = normalizeVaultRoot(vaultPath);
    if (!normalizedVaultPath) {
        return normalizedPath;
    }

    return `${normalizedVaultPath}/${normalizedPath.replace(/^\/+/, "")}`;
}

export function toVaultRelativePath(
    path: string,
    vaultPath: string | null,
): string | null {
    const normalizedPath = normalizeVaultPath(path);
    if (!isAbsoluteVaultPath(normalizedPath)) {
        return normalizedPath;
    }

    const normalizedVaultPath = normalizeVaultRoot(vaultPath);
    if (!normalizedVaultPath) {
        return null;
    }

    const prefix = `${normalizedVaultPath}/`;
    if (!normalizedPath.startsWith(prefix)) {
        return null;
    }

    return normalizedPath.slice(prefix.length);
}
