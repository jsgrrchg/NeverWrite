export type AgentSnoozePresetId =
    | "one-hour"
    | "later-today"
    | "tomorrow"
    | "next-week";

export interface AgentSnoozePreset {
    id: AgentSnoozePresetId;
    label: string;
}

export const AGENT_SNOOZE_PRESETS: readonly AgentSnoozePreset[] = [
    { id: "one-hour", label: "1 hour" },
    { id: "later-today", label: "Later today" },
    { id: "tomorrow", label: "Tomorrow" },
    { id: "next-week", label: "Next week" },
];

export const MAX_SAFE_TIMEOUT_DELAY = 2_147_483_647;

export function resolveAgentSnoozeTimestamp(
    preset: AgentSnoozePresetId,
    now: number,
) {
    if (preset === "one-hour") return now + 60 * 60_000;
    const date = new Date(now);
    if (preset === "later-today") {
        const targetHour = Math.min(23, Math.max(18, date.getHours() + 3));
        date.setHours(targetHour, targetHour === 23 ? 59 : 0, 0, 0);
        return Math.max(date.getTime(), now + 15 * 60_000);
    }
    if (preset === "tomorrow") {
        date.setDate(date.getDate() + 1);
        date.setHours(9, 0, 0, 0);
        return date.getTime();
    }
    const daysUntilNextMonday = ((8 - date.getDay()) % 7) || 7;
    date.setDate(date.getDate() + daysUntilNextMonday);
    date.setHours(9, 0, 0, 0);
    return date.getTime();
}

export function getSafeSnoozeDelay(now: number, wakeAt: number) {
    return Math.min(
        MAX_SAFE_TIMEOUT_DELAY,
        Math.max(0, wakeAt - now + 25),
    );
}

export function formatSnoozeWakeLabel(wakeAt: number, now: number) {
    const target = new Date(wakeAt);
    const today = new Date(now);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const time = new Intl.DateTimeFormat("en", {
        hour: "numeric",
        minute: "2-digit",
    }).format(target);
    if (target.toDateString() === today.toDateString()) return `Today ${time}`;
    if (target.toDateString() === tomorrow.toDateString()) {
        return `Tomorrow ${time}`;
    }
    return new Intl.DateTimeFormat("en", {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
    }).format(target);
}
