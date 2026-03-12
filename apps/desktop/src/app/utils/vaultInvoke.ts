import { invoke } from "@tauri-apps/api/core";
import { useVaultStore } from "../store/vaultStore";

let _ipcTracing = false;
const _ipcStats = new Map<
    string,
    { count: number; totalMs: number; maxMs: number }
>();

/**
 * Wrapper around Tauri's invoke that automatically injects `vaultPath`
 * from the current vault store state. Use for all vault-scoped commands
 * (read_note, save_note, search_notes, etc.).
 *
 * Do NOT use for commands that specify their own vault path (e.g. start_open_vault).
 */
export async function vaultInvoke<T>(
    cmd: string,
    args?: Record<string, unknown>,
): Promise<T> {
    const vaultPath = useVaultStore.getState().vaultPath ?? "";
    if (!_ipcTracing) {
        return invoke<T>(cmd, { ...args, vaultPath });
    }

    const start = performance.now();
    try {
        const result = await invoke<T>(cmd, { ...args, vaultPath });
        recordIpc(cmd, performance.now() - start);
        return result;
    } catch (error) {
        recordIpc(cmd, performance.now() - start);
        throw error;
    }
}

function recordIpc(cmd: string, ms: number) {
    const stats = _ipcStats.get(cmd) ?? { count: 0, totalMs: 0, maxMs: 0 };
    stats.count += 1;
    stats.totalMs += ms;
    stats.maxMs = Math.max(stats.maxMs, ms);
    _ipcStats.set(cmd, stats);

    if (ms > 50) {
        console.warn(`[ipc] ${cmd} took ${ms.toFixed(1)}ms`);
    }
}

// Expose debug API on window for console use
if (typeof window !== "undefined") {
    ((window as unknown) as Record<string, unknown>).__ipcDebug = {
        enable() {
            _ipcTracing = true;
            // Also enable Rust-side timing
            void invoke("debug_set_timing", { enabled: true });
            console.log("[ipc] Tracing enabled (frontend + Rust)");
        },
        disable() {
            _ipcTracing = false;
            void invoke("debug_set_timing", { enabled: false });
            console.log("[ipc] Tracing disabled");
        },
        summary() {
            const rows = [..._ipcStats.entries()]
                .map(([cmd, s]) => ({
                    command: cmd,
                    calls: s.count,
                    avgMs: Number((s.totalMs / s.count).toFixed(1)),
                    maxMs: Number(s.maxMs.toFixed(1)),
                    totalMs: Number(s.totalMs.toFixed(1)),
                }))
                .sort((a, b) => b.totalMs - a.totalMs);
            console.table(rows);
            return rows;
        },
        reset() {
            _ipcStats.clear();
            console.log("[ipc] Stats reset");
        },
    };
}
