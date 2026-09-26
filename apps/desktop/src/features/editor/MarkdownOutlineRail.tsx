import { resolveOutlineRailLayout } from "./markdownOutlineRailLayout";
import { useMemo, useSyncExternalStore } from "react";
import { NavigationRail } from "../../components/navigation/NavigationRail";
import type { OutlineHeading } from "../notes/outlineModel";
import type { EditorOutlineBridge } from "./extensions/editorOutline";

export function MarkdownOutlineRail({ bridge }: { bridge: EditorOutlineBridge }) {
    const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
    const parents = useMemo(() => {
        const result = new Map<string, string>();
        const stack: OutlineHeading[] = [];
        for (const heading of snapshot.headings) {
            while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
            result.set(heading.id, stack.map((parent) => parent.title).join(" › "));
            stack.push(heading);
        }
        return result;
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
                expandedWidth={layout.previewWidth + 32}
                getStripWidth={(heading) => 20 - heading.level * 2}
                isInView={(heading) => heading.id === snapshot.activeId}
                getLabel={(heading) => heading
                    ? `Jump to heading: ${heading.title} (H${heading.level})`
                    : "Jump to heading"}
                onSelect={bridge.select}
                renderPreview={(heading) => (
                    <>
                        <span className="block truncate text-xs leading-4 text-text-secondary">
                            {parents.get(heading.id) || "Document"} · H{heading.level}
                        </span>
                        <span className="mt-1 block truncate text-xs font-medium leading-4">
                            {heading.title}
                        </span>
                    </>
                )}
            />
        </nav>
    );
}
