import os from "node:os";

/**
 * Resolve the OS account name of the current user.
 *
 * Chain: `os.userInfo().username`, then the `USER` (POSIX) / `USERNAME`
 * (Windows) environment variables, then `null`. `os.userInfo()` can throw on
 * some systems (e.g. no entry in the password database), so the env fallback
 * matters. Callers must treat `null` as "unknown" and omit the value rather
 * than writing a placeholder.
 */
export function resolveSystemUsername(
    env: Record<string, string | undefined> = process.env,
    userInfo: () => { username: string } = () => os.userInfo(),
): string | null {
    try {
        const name = userInfo().username;
        if (typeof name === "string" && name.trim()) {
            return name.trim();
        }
    } catch {
        // Fall through to the environment variables.
    }

    const fallback = env.USER ?? env.USERNAME;
    if (typeof fallback === "string" && fallback.trim()) {
        return fallback.trim();
    }

    return null;
}

let cachedUsername: string | null | undefined;

/** Cached variant used by the IPC layer; the username cannot change mid-run. */
export function getSystemUsername(): string | null {
    if (cachedUsername === undefined) {
        cachedUsername = resolveSystemUsername();
    }
    return cachedUsername;
}

export function resetSystemUsernameCacheForTests() {
    cachedUsername = undefined;
}
