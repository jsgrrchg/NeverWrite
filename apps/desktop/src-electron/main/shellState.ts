import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

const RECENT_VAULTS_FILE = "recent_vaults.json";
const MAX_RECENT_VAULTS = 15;

export type WindowRouteKind = "main" | "note" | "settings" | "ghost" | "unknown";

export interface RecentVaultEntry {
    path: string;
    name: string;
}

export interface WindowVaultRoute {
    label: string;
    vaultPath: string | null;
    windowKind: WindowRouteKind;
    lastSeenMs: number;
}

const windowVaultRoutes = new Map<string, WindowVaultRoute>();
let recentVaults: RecentVaultEntry[] = [];
let recentVaultsLoaded = false;

function recentVaultsFilePath() {
    return path.join(app.getPath("userData"), RECENT_VAULTS_FILE);
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
}

function cleanString(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function windowKindFromMode(value: unknown): WindowRouteKind {
    switch (value) {
        case "main":
        case "note":
        case "settings":
        case "ghost":
            return value;
        default:
            return "unknown";
    }
}

function sanitizeRecentVaults(value: unknown): RecentVaultEntry[] {
    if (!Array.isArray(value)) return [];

    const sanitized: RecentVaultEntry[] = [];
    const seen = new Set<string>();

    for (const item of value) {
        const record = asRecord(item);
        const vaultPath = cleanString(record.path);
        const name = cleanString(record.name);
        if (!vaultPath || !name || seen.has(vaultPath)) continue;

        sanitized.push({ path: vaultPath, name });
        seen.add(vaultPath);
        if (sanitized.length >= MAX_RECENT_VAULTS) break;
    }

    return sanitized;
}

export async function loadRecentVaults() {
    if (recentVaultsLoaded) return recentVaults;

    try {
        const contents = await fs.readFile(recentVaultsFilePath(), "utf8");
        recentVaults = sanitizeRecentVaults(JSON.parse(contents));
    } catch {
        recentVaults = [];
    }

    recentVaultsLoaded = true;
    return recentVaults;
}

export function getRecentVaultsSnapshot() {
    return recentVaults;
}

export async function syncRecentVaults(rawVaults: unknown) {
    recentVaults = sanitizeRecentVaults(rawVaults);
    recentVaultsLoaded = true;

    const filePath = recentVaultsFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(recentVaults, null, 2), "utf8");
    return recentVaults;
}

export function registerWindowVaultRoute(rawArgs: Record<string, unknown>) {
    const label = cleanString(rawArgs.label);
    if (!label) return;

    const vaultPath = cleanString(rawArgs.vaultPath ?? rawArgs.vault_path);
    windowVaultRoutes.set(label, {
        label,
        vaultPath: vaultPath || null,
        windowKind: windowKindFromMode(rawArgs.windowMode ?? rawArgs.window_mode),
        lastSeenMs: Date.now(),
    });
}

export function unregisterWindowVaultRoute(rawArgs: Record<string, unknown>) {
    const label = cleanString(rawArgs.label);
    if (!label) return;
    windowVaultRoutes.delete(label);
}

export function removeWindowVaultRoute(label: string) {
    windowVaultRoutes.delete(label);
}

export function getWindowVaultRoute(label: string) {
    return windowVaultRoutes.get(label) ?? null;
}

export function selectMainWindowRouteLabel() {
    return [...windowVaultRoutes.values()]
        .filter((route) => route.windowKind === "main")
        .sort(compareRoutesByRecency)[0]?.label ?? null;
}

function windowRouteLabelRank(label: string) {
    return label === "main" ? 0 : 1;
}

function compareRoutesByRecency(left: WindowVaultRoute, right: WindowVaultRoute) {
    return (
        right.lastSeenMs - left.lastSeenMs ||
        windowRouteLabelRank(left.label) - windowRouteLabelRank(right.label) ||
        left.label.localeCompare(right.label)
    );
}
