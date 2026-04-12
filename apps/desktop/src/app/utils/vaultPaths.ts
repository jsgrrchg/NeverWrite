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

/**
 * Best-effort canonical form for frontend vault-scoped paths.
 *
 * - Relative vault paths become absolute paths under the current vault root.
 * - Absolute paths stay absolute.
 *
 * This deliberately does not reinterpret legacy slash-prefixed relative paths
 * like `/src/file.ts`, because those are ambiguous with real absolute paths and
 * must be handled only in legacy-compat matching code.
 */
export function canonicalizeVaultScopedPath(
    path: string,
    vaultPath: string | null,
) {
    return resolveVaultAbsolutePath(path, vaultPath).replace(/\/+$/, "");
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

function isPathInsideVaultRoot(
    path: string,
    normalizedVaultPath: string | null,
) {
    if (!normalizedVaultPath) {
        return false;
    }

    return (
        path === normalizedVaultPath ||
        path.startsWith(`${normalizedVaultPath}/`)
    );
}

/**
 * Build equivalent path aliases for comparing vault-scoped paths that may be:
 * - relative to the vault root (`src/file.ts`)
 * - absolute inside the vault (`/vault/src/file.ts`)
 * - legacy slash-prefixed relative (`/src/file.ts`)
 */
export function buildVaultPathAliases(
    path: string,
    vaultPath: string | null,
    options?: {
        includeLegacyLeadingSlashRelative?: boolean;
    },
) {
    const normalizedPath = normalizeVaultPath(path).replace(/\/+$/, "");
    if (!normalizedPath) {
        return [];
    }

    const aliases = new Set<string>();
    const push = (candidate: string | null | undefined) => {
        if (typeof candidate !== "string" || candidate.length === 0) {
            return;
        }

        aliases.add(normalizeVaultPath(candidate).replace(/\/+$/, ""));
    };

    push(normalizedPath);

    const relativePath = toVaultRelativePath(normalizedPath, vaultPath);
    if (relativePath) {
        push(relativePath);
        push(resolveVaultAbsolutePath(relativePath, vaultPath));
    }

    if (
        options?.includeLegacyLeadingSlashRelative &&
        normalizedPath.startsWith("/") &&
        !/^[A-Za-z]:\//.test(normalizedPath)
    ) {
        const normalizedVaultPath = normalizeVaultRoot(vaultPath);
        if (!isPathInsideVaultRoot(normalizedPath, normalizedVaultPath)) {
            const strippedPath = normalizedPath.replace(/^\/+/, "");
            if (strippedPath.length > 0) {
                push(strippedPath);
                push(resolveVaultAbsolutePath(strippedPath, vaultPath));
            }
        }
    }

    return [...aliases];
}

export function pathsMatchVaultScoped(
    leftPath: string,
    rightPath: string,
    vaultPath: string | null,
    options?: {
        includeLegacyLeadingSlashRelative?: boolean;
    },
) {
    const rightAliases = new Set(
        buildVaultPathAliases(rightPath, vaultPath, options),
    );
    return buildVaultPathAliases(leftPath, vaultPath, options).some((alias) =>
        rightAliases.has(alias),
    );
}
