import { resolveOutlineRailLayout } from "./markdownOutlineRailLayout";
import { useMemo, useSyncExternalStore } from "react";
import { NavigationRail } from "../../components/navigation/NavigationRail";
import type { OutlineHeading } from "../notes/outlineModel";
import type { EditorOutlineBridge } from "./extensions/editorOutline";

// Deep outlines keep the nearest ancestors; the rest collapse into an ellipsis.
const MAX_PREVIEW_ANCESTORS = 3;
// Elbow width + gap, so each elbow hangs under its parent's title.
const PREVIEW_INDENT = 14;

function TreeElbow() {
    return (
        <span
            aria-hidden="true"
            className="-mt-2 h-2.5 w-2 shrink-0 rounded-bl-[3px] border-b border-l"
            style={{ borderColor: "color-mix(in srgb, var(--text-secondary) 45%, transparent)" }}
        />
    );
}

function HeadingPreview({ heading, ancestors }: { heading: OutlineHeading; ancestors: readonly OutlineHeading[] }) {
    const hidden = Math.max(0, ancestors.length - MAX_PREVIEW_ANCESTORS);
    const trail = ancestors.slice(hidden);
    const depth = trail.length + (hidden > 0 ? 1 : 0);
    return (
        <span className="flex flex-col gap-1" data-outline-preview>
            {hidden > 0 ? (
                <span className="block text-[11px] leading-4 text-text-secondary">…</span>
            ) : null}
            {trail.map((ancestor, index) => {
                const step = index + (hidden > 0 ? 1 : 0);
                return (
                    <span
                        key={ancestor.id}
                        className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-text-secondary"
                        data-outline-preview-ancestor
                        style={{ paddingLeft: Math.max(0, step - 1) * PREVIEW_INDENT }}
                    >
                        {step > 0 ? <TreeElbow /> : null}
                        <span className="truncate">{ancestor.title}</span>
                    </span>
                );
            })}
            <span
                className="flex min-w-0 items-center gap-1.5"
                style={{ paddingLeft: Math.max(0, depth - 1) * PREVIEW_INDENT }}
            >
                {depth > 0 ? <TreeElbow /> : null}
                <span
                    className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-5 text-text-primary"
                    data-outline-preview-title
                >
                    {heading.title}
                </span>
                <span
                    className="shrink-0 rounded-md px-1.5 font-mono text-[10px] font-medium leading-4"
                    style={{
                        color: "var(--accent)",
                        background: "color-mix(in srgb, var(--accent) 14%, transparent)",
                    }}
                >
                    H{heading.level}
                </span>
            </span>
        </span>
    );
}

export function MarkdownOutlineRail({ bridge }: { bridge: EditorOutlineBridge }) {
    const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
    const { ancestors, indexes } = useMemo(() => {
        const ancestors = new Map<string, OutlineHeading[]>();
        const indexes = new Map<string, number>();
        const stack: OutlineHeading[] = [];
        snapshot.headings.forEach((heading, index) => {
            while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
            ancestors.set(heading.id, [...stack]);
            indexes.set(heading.id, index);
            stack.push(heading);
        });
        return { ancestors, indexes };
    }, [snapshot.headings]);
    const layout = resolveOutlineRailLayout(snapshot, snapshot.headings.length);
    if (!layout) return null;

    return (
        <nav
            aria-label="Document outline"
            className="pointer-events-none absolute inset-y-0 left-0 z-20"
            style={{ right: snapshot.rightInset }}
        >
            <NavigationRail
                side="right"
                testId="markdown-outline-rail"
                items={snapshot.headings}
                height={layout.height}
                hitStripWidth={layout.hitStripWidth}
                hasPersistentGutter={layout.hasPersistentGutter}
                previewWidth={layout.previewWidth}
                // H1 matches the chat prompt strip; deeper levels step down subtly.
                getStripWidth={(heading) => Math.max(3, 9 - heading.level)}
                isInView={(heading) => {
                    const index = indexes.get(heading.id) ?? -1;
                    return index >= snapshot.inViewStart && index <= snapshot.inViewEnd && index >= 0;
                }}
                getLabel={(heading) => heading
                    ? `Jump to heading: ${heading.title} (H${heading.level})`
                    : "Jump to heading"}
                onSelect={bridge.select}
                renderPreview={(heading) => (
                    <HeadingPreview heading={heading} ancestors={ancestors.get(heading.id) ?? []} />
                )}
            />
        </nav>
    );
}
