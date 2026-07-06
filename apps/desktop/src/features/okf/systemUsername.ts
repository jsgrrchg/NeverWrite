import { invoke } from "@neverwrite/runtime";

let cached: string | null | undefined;

/**
 * OS account name of the current user, fetched once from the Electron main
 * process (`get_system_username`) and cached for the session. Returns `null`
 * when the username cannot be determined; callers must then omit
 * attribution fields (e.g. `status_by`) rather than write a placeholder.
 *
 * Failures are not cached, so a transient IPC error does not permanently
 * disable attribution.
 */
export async function fetchSystemUsername(): Promise<string | null> {
    if (cached !== undefined) return cached;
    try {
        const value = await invoke<unknown>("get_system_username");
        cached =
            typeof value === "string" && value.trim() ? value.trim() : null;
        return cached;
    } catch {
        return null;
    }
}

export function resetSystemUsernameCacheForTests() {
    cached = undefined;
}
