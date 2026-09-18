export function getCompactLocationSegments(segments: string[]) {
    if (segments.length <= 2) return segments;
    return [segments[0], "…", segments.at(-1)!];
}
