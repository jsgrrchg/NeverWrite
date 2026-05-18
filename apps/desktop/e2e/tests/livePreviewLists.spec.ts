import { expect, test } from "@playwright/test";

/**
 * Regression coverage for jsgrrchg/NeverWrite#102.
 *
 * Two visual properties must hold for an active empty list item:
 *
 *   1. Horizontal: the caret sits at the line's content-box left edge
 *      (flush with the rendered pseudo-bullet + gap). If the trailing
 *      source space leaks through, the caret drifts ~1ch past that.
 *
 *   2. Vertical / visibility: the caret has a non-zero rect. If the
 *      line's source content is fully collapsed to font-size: 0 hidden
 *      spans, the native caret's getClientRects() reports a 0x0 rect
 *      and the caret is invisible.
 *
 * Both assertions together catch:
 *   - main today: caret is visible but ~9.6 px past content-box left.
 *   - "collapse the full prefix" attempt: caret is at the right x but
 *     has 0 height/width.
 */

type CaretMeasurement = {
    cursorLeft: number;
    cursorWidth: number;
    cursorHeight: number;
    contentBoxLeft: number;
};

const MIN_CARET_HEIGHT_PX = 10; // anything below this is effectively invisible
const POSITION_TOLERANCE_PX = 2;

async function measureCaretAtLine(
    page: import("@playwright/test").Page,
    lineNumber: number,
): Promise<CaretMeasurement> {
    return page.evaluate((nth) => {
        const lines = document.querySelectorAll(".cm-content > .cm-line");
        const line = lines[nth - 1] as HTMLElement | undefined;
        if (!line) throw new Error(`line ${nth} not found (have ${lines.length})`);

        // With drawSelection() (matching the real editor), the caret is a
        // CM-rendered .cm-cursor element inside .cm-cursorLayer rather than
        // the native browser caret. Measure that.
        const cursor = document.querySelector(
            ".cm-cursorLayer .cm-cursor",
        ) as HTMLElement | null;
        if (!cursor) throw new Error("caret element not found");

        const caretRect = cursor.getBoundingClientRect();
        const lineRect = line.getBoundingClientRect();
        const paddingLeft = parseFloat(
            window.getComputedStyle(line).paddingLeft,
        );

        return {
            cursorLeft: caretRect.left,
            cursorWidth: caretRect.width,
            cursorHeight: caretRect.height,
            contentBoxLeft: lineRect.left + paddingLeft,
        };
    }, lineNumber);
}

function expectCaretAnchoredToBullet(measurement: CaretMeasurement) {
    expect(Math.abs(measurement.cursorLeft - measurement.contentBoxLeft))
        .toBeLessThan(POSITION_TOLERANCE_PX);
    expect(measurement.cursorHeight).toBeGreaterThanOrEqual(
        MIN_CARET_HEIGHT_PX,
    );
}

test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(
        () => typeof (window as unknown as { mountEditor?: unknown })
                .mountEditor === "function",
    );
});

// ---------------------------------------------------------------------------
// Unordered list — active empty
// ---------------------------------------------------------------------------

test("active empty top-level list item: caret sits flush with the bullet (#102)", async ({
    page,
}) => {
    await page.evaluate(() => {
        window.mountEditor({ doc: "- ", selection: 2 });
    });
    await page.waitForSelector(".cm-lp-li-line");
    await page.locator(".cm-content").focus();

    expectCaretAnchoredToBullet(await measureCaretAtLine(page, 1));
});

test("active empty nested list item: caret sits flush with the bullet (#102)", async ({
    page,
}) => {
    await page.evaluate(() => {
        window.mountEditor({ doc: "- parent\n    - ", selection: 15 });
    });
    await page.waitForSelector(".cm-lp-li-line");
    await page.locator(".cm-content").focus();

    expect(await page.locator(".cm-lp-li-line").count()).toBeGreaterThanOrEqual(
        2,
    );
    expectCaretAnchoredToBullet(await measureCaretAtLine(page, 2));
});

test("active empty middle list item: caret sits flush with the bullet (#102)", async ({
    page,
}) => {
    // Empty item sandwiched between two non-empty items at the same level.
    await page.evaluate(() => {
        window.mountEditor({
            doc: "- alpha\n- \n- gamma",
            selection: 10,
        });
    });
    await page.waitForSelector(".cm-lp-li-line");
    await page.locator(".cm-content").focus();

    expectCaretAnchoredToBullet(await measureCaretAtLine(page, 2));
});

test("active empty middle item with nested child below (issue repro #102)", async ({
    page,
}) => {
    // Exact case from the issue body:
    //   - Probando
    //   - <caret>
    //       - eeeee
    const doc = "- Probando\n- \n    - eeeee";
    await page.evaluate((d) => {
        window.mountEditor({ doc: d, selection: 13 });
    }, doc);
    await page.waitForSelector(".cm-lp-li-line");
    await page.locator(".cm-content").focus();

    expectCaretAnchoredToBullet(await measureCaretAtLine(page, 2));
});

test("clicking an active empty list prefix keeps the caret visible (#102)", async ({
    page,
}) => {
    const doc = "- eee\n- ewgfreg\n- ewfwef\n- ";
    await page.evaluate((d) => {
        window.mountEditor({ doc: d, selection: d.length });
    }, doc);
    await page.waitForSelector(".cm-lp-li-line");

    const emptyLine = page.locator(".cm-content > .cm-line").nth(3);
    const box = await emptyLine.boundingBox();
    if (!box) throw new Error("empty list line not measurable");

    await page.mouse.click(box.x + 8, box.y + box.height / 2);

    const selectionHead = await page.evaluate(() => {
        return window.editorView?.state.selection.main.head ?? null;
    });

    expect(selectionHead).toBe(doc.length);
    expectCaretAnchoredToBullet(await measureCaretAtLine(page, 4));
});

test("clicking an inactive empty list item activates its caret anchor (#102)", async ({
    page,
}) => {
    const doc = "- eee\n- \n    - rrrrr";
    await page.evaluate((d) => {
        window.mountEditor({ doc: d, selection: 5 });
    }, doc);
    await page.waitForSelector(".cm-lp-li-line");

    const emptyLine = page.locator(".cm-content > .cm-line").nth(1);
    const box = await emptyLine.boundingBox();
    if (!box) throw new Error("empty list line not measurable");

    await page.mouse.click(box.x + 8, box.y + box.height / 2);

    const selectionHead = await page.evaluate(() => {
        return window.editorView?.state.selection.main.head ?? null;
    });

    expect(selectionHead).toBe(8);
    expectCaretAnchoredToBullet(await measureCaretAtLine(page, 2));
});

// ---------------------------------------------------------------------------
// Task list — active empty (acceptance criterion: tasks not regressed)
// ---------------------------------------------------------------------------

test("active empty top-level task item: caret sits flush with the checkbox (#102)", async ({
    page,
}) => {
    await page.evaluate(() => {
        window.mountEditor({ doc: "- [ ] ", selection: 6 });
    });
    await page.waitForSelector(".cm-lp-task-line");
    await page.locator(".cm-content").focus();

    expectCaretAnchoredToBullet(await measureCaretAtLine(page, 1));
});

test("active empty nested task item: caret sits flush with the checkbox (#102)", async ({
    page,
}) => {
    const doc = "- [ ] parent\n    - [ ] ";
    await page.evaluate((d) => {
        window.mountEditor({ doc: d, selection: d.length });
    }, doc);
    await page.waitForSelector(".cm-lp-task-line");
    await page.locator(".cm-content").focus();

    expectCaretAnchoredToBullet(await measureCaretAtLine(page, 2));
});

// ---------------------------------------------------------------------------
// Ordered list — active empty (different presentation code path)
// ---------------------------------------------------------------------------

test("active empty top-level ordered list item: caret sits flush with the marker (#102)", async ({
    page,
}) => {
    await page.evaluate(() => {
        window.mountEditor({ doc: "1. ", selection: 3 });
    });
    await page.waitForSelector(".cm-lp-li-line");
    await page.locator(".cm-content").focus();

    expectCaretAnchoredToBullet(await measureCaretAtLine(page, 1));
});

// ---------------------------------------------------------------------------
// Inactive baseline — must not regress
// ---------------------------------------------------------------------------

test("inactive empty list item still renders a bullet without raw markdown", async ({
    page,
}) => {
    // Cursor is on line 1 ("- alpha"); line 2 is "- " but inactive.
    // Live preview should keep the bullet visible and hide the raw "- ".
    await page.evaluate(() => {
        window.mountEditor({ doc: "- alpha\n- ", selection: 5 });
    });
    await page.waitForSelector(".cm-lp-li-line");
    await page.locator(".cm-content").focus();

    const line2 = await page.evaluate(() => {
        const lines = document.querySelectorAll(".cm-content > .cm-line");
        const line = lines[1] as HTMLElement | undefined;
        if (!line) return null;

        // innerText still includes text styled with width:0 + font-size:0,
        // so assert on actual rendered geometry instead.
        const sourceMarkerWidths: number[] = [];
        for (const child of Array.from(line.childNodes)) {
            if (child.nodeType !== Node.ELEMENT_NODE) continue;
            const el = child as HTMLElement;
            const text = el.textContent ?? "";
            if (!text.includes("-")) continue;
            sourceMarkerWidths.push(el.getBoundingClientRect().width);
        }

        return {
            hasLiClass: line.classList.contains("cm-lp-li-line"),
            maxMarkerWidth: sourceMarkerWidths.length
                ? Math.max(...sourceMarkerWidths)
                : 0,
        };
    });

    expect(line2).not.toBeNull();
    expect(line2!.hasLiClass).toBe(true);
    // Any DOM child holding the raw "- " source must render at zero width
    // so the marker is not visually duplicated next to the pseudo-bullet.
    expect(line2!.maxMarkerWidth).toBeLessThan(1);
});

// ---------------------------------------------------------------------------
// Control — non-empty item must continue to work
// ---------------------------------------------------------------------------

test("non-empty list item: caret sits past content-box (control)", async ({
    page,
}) => {
    await page.evaluate(() => {
        window.mountEditor({ doc: "- abc", selection: 5 });
    });
    await page.waitForSelector(".cm-lp-li-line");
    await page.locator(".cm-content").focus();

    const measurement = await measureCaretAtLine(page, 1);

    expect(measurement.cursorLeft).toBeGreaterThan(measurement.contentBoxLeft);
    expect(measurement.cursorHeight).toBeGreaterThanOrEqual(
        MIN_CARET_HEIGHT_PX,
    );
});
