export const ACTIVITY_DISPLAY_MODES = [
    "expanded",
    "collapsed",
    "hidden",
] as const;

export type ActivityDisplayMode = (typeof ACTIVITY_DISPLAY_MODES)[number];

export function normalizeActivityDisplayMode(
    value: unknown,
): ActivityDisplayMode {
    return value === "expanded" || value === "hidden" ? value : "collapsed";
}
