import type { EditorOutlineSnapshot } from "./extensions/editorOutline";

export function resolveOutlineRailLayout({ width, height, gutter, rightInset }: EditorOutlineSnapshot, count: number) {
    // Keep the entire resting hit strip in the editor's actual padding. This
    // also hides it when unwrapped text extends past the viewport's right edge.
    const hitStripWidth = Math.min(40, Math.floor(gutter) - 16);
    if (count < 2 || width < 240 || height < 128 || hitStripWidth < 24) return null;
    return {
        hitStripWidth,
        hasPersistentGutter: gutter >= 48,
        height: Math.min(Math.max(24, (count - 1) * 8), height - 96),
        previewWidth: Math.min(320, width - rightInset - 64),
    };
}

