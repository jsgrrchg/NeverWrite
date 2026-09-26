import { expect, test, type Page } from "@playwright/test";
import type {} from "../harness/editorFixture";

const content = "---\ntitle: Outline\n---\n# Root\n\n" + Array.from({ length: 30 }, (_, i) =>
    `## Section ${i}\n\n${"A paragraph with **formatted** text.\n\n".repeat(30)}`,
).join("");

const rail = (page: Page) => page.getByTestId("markdown-outline-rail");
const button = (page: Page) => rail(page).getByRole("button");

async function mount(page: Page, doc = content) {
    await page.evaluate((content) => window.editorFixture.mount([
        { id: "outline", noteId: "outline", title: "Outline", content },
    ]), doc);
    await expect(rail(page)).toBeVisible();
}

async function expectSelection(page: Page, title: string) {
    await expect.poll(() => page.evaluate(() => {
        const view = window.editorFixture.getView();
        return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    })).toBe(title);
}

test.beforeEach(async ({ page }) => {
    await page.goto("/editor.html");
    await page.waitForFunction(() => Boolean(window.editorFixture));
});

test("jumps to virtualized headings and back to the collapsed leading H1", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mount(page);
    await expect(page.locator(".cm-content")).not.toContainText("Section 29");
    await button(page).focus();
    await button(page).press("End");
    await expect(button(page)).toHaveAccessibleName("Jump to heading: Section 29 (H2)");
    await button(page).press("Enter");
    await expectSelection(page, "## Section 29");
    await expect.poll(() => page.evaluate(() => window.editorFixture.snapshot().scrollTop)).toBeGreaterThan(1000);
    await expect(page.locator(".cm-content")).toContainText("Section 29");
    await expect(page.locator(".cm-lp-line-flash")).toBeVisible();

    await button(page).focus();
    await button(page).press("Home");
    await button(page).press("Enter");
    await expectSelection(page, "# Root");
    await expect.poll(() => page.evaluate(() => window.editorFixture.snapshot().scrollTop)).toBeLessThan(300);
    expect(errors).toEqual([]);
});

test("uses fresh heading offsets after editing and external document replacement", async ({ page }) => {
    await mount(page, "# Root\n\n## Target\nBody");
    await page.evaluate(() => {
        const view = window.editorFixture.getView();
        view.dispatch({ changes: { from: 8, insert: "New paragraph\n\n" } });
    });
    await button(page).focus();
    await button(page).press("End");
    await button(page).press("Enter");
    await expectSelection(page, "## Target");

    await page.evaluate(() => {
        const view = window.editorFixture.getView();
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "# Replaced\n\n### New destination\nText" } });
    });
    await button(page).focus();
    await button(page).press("End");
    await button(page).press("Enter");
    await expectSelection(page, "### New destination");
});

test("keeps a long section active when its heading is no longer rendered", async ({ page }) => {
    await mount(page);
    await page.evaluate(() => { window.editorFixture.getView().scrollDOM.scrollTop = 700; });
    const strips = rail(page).locator("[data-prompt-ring-strip]");
    await expect(strips.nth(1)).toHaveAttribute("data-in-view", "true");
    await page.evaluate(() => { window.editorFixture.getView().scrollDOM.scrollTop = 1200; });
    await expect(strips.nth(1)).toHaveAttribute("data-in-view", "true");
    await page.evaluate(() => {
        const view = window.editorFixture.getView();
        view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
    });
    await expect(strips.last()).toHaveAttribute("data-in-view", "true");
});

test("fits the panel and leaves the text and scrollbar interactive", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 280 });
    await mount(page);
    const resting = await button(page).boundingBox();
    expect(resting).not.toBeNull();
    expect(resting!.height).toBeLessThan(200);
    const hitTargets = await page.evaluate(() => {
        const view = window.editorFixture.getView();
        const bounds = view.scrollDOM.getBoundingClientRect();
        const y = bounds.top + bounds.height / 2;
        return [bounds.left + 100, bounds.right - 3].map((x) =>
            document.elementFromPoint(x, y)?.closest('[data-testid="markdown-outline-rail"]') === null,
        );
    });
    expect(hitTargets).toEqual([true, true]);
    await button(page).focus();
    await button(page).press("End");
    const preview = await rail(page).locator("[data-navigation-rail-preview]").boundingBox();
    expect(preview!.x).toBeGreaterThanOrEqual(0);
    expect(preview!.y).toBeGreaterThanOrEqual(24);
    expect(preview!.y + preview!.height).toBeLessThanOrEqual(280);

    await page.setViewportSize({ width: 280, height: 280 });
    await expect(rail(page)).toHaveCount(0);
    await page.setViewportSize({ width: 1100, height: 500 });
    await expect(rail(page)).toBeVisible();
});

test("hides in source mode and refreshes on tab switches", async ({ page }) => {
    await page.evaluate((content) => window.editorFixture.mount([
        { id: "outline", noteId: "outline", title: "Outline", content },
        { id: "other", noteId: "other", title: "Other", content: "# Another\n\n## Destination" },
        { id: "plain", noteId: "plain", title: "Plain", content: "No headings here" },
    ]), content);
    await expect(rail(page)).toBeVisible();
    await page.evaluate(() => window.editorFixture.setPreview(false));
    await expect(rail(page)).toHaveCount(0);
    await page.evaluate(() => window.editorFixture.setPreview(true));
    await expect(rail(page)).toBeVisible();
    await button(page).focus();
    await button(page).press("End");
    await page.getByRole("button", { name: "Other", exact: true }).click();
    await button(page).focus();
    await button(page).press("End");
    await button(page).press("Enter");
    await expectSelection(page, "## Destination");
    await page.getByRole("button", { name: "Plain", exact: true }).click();
    await expect(rail(page)).toHaveCount(0);
});

test("each column scrolls independently", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 700 });
    await page.evaluate((content) => window.editorFixture.mount([
        { id: "left", noteId: "left", title: "Left", content },
        { id: "right", noteId: "right", title: "Right", content },
    ], true, "columns"), content);
    await expect(rail(page)).toHaveCount(2);
    const right = rail(page).nth(1).getByRole("button");
    await right.focus();
    await right.press("End");
    await right.press("Enter");
    const scrollers = page.locator(".cm-scroller");
    await expect.poll(() => scrollers.nth(1).evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
    expect(await scrollers.nth(0).evaluate((el) => el.scrollTop)).toBe(0);
});

test("navigates inside stacked columns", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 700 });
    await page.evaluate((content) => window.editorFixture.mount([
        { id: "first", noteId: "first", title: "First", content },
        { id: "second", noteId: "second", title: "Second", content },
    ], true, "stacked"), content);
    const target = rail(page).first().getByRole("button");
    await expect(target).toBeVisible();
    const box = await target.boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height - 1);
    await expectSelection(page, "## Section 29");
});

test("jumps correctly after an image changes height above a table", async ({ page }) => {
    await page.route("https://outline.test/diagram.svg", (route) => route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="gray"/></svg>',
    }));
    await mount(page, "# Root\n\n![Diagram](https://outline.test/diagram.svg)\n\n" +
        "| A | B |\n| --- | --- |\n" + "| One | Two |\n".repeat(20) +
        "\n## After widgets\n\n" + "Paragraph\n\n".repeat(40));
    const image = page.locator(".cm-inline-image");
    await expect(image).toBeVisible();
    await image.evaluate((element) => { element.style.height = "450px"; });
    await expect.poll(() => image.evaluate((element) => element.getBoundingClientRect().height)).toBe(450);
    await button(page).focus();
    await button(page).press("End");
    await button(page).press("Enter");
    await expectSelection(page, "## After widgets");
    await expect.poll(() => page.evaluate(() => {
        const view = window.editorFixture.getView();
        const rect = view.coordsAtPos(view.state.selection.main.from);
        const bounds = view.scrollDOM.getBoundingClientRect();
        return Boolean(rect && rect.top >= bounds.top && rect.bottom <= bounds.bottom);
    })).toBe(true);
});

test("hides when unwrapped content occupies the right gutter", async ({ page }) => {
    await mount(page, "# Root\n\n" + "Very long line ".repeat(200) + "\n\n## End");
    await page.evaluate(() => window.editorFixture.setLineWrapping(false));
    await expect(rail(page)).toHaveCount(0);
    await page.evaluate(() => window.editorFixture.setLineWrapping(true));
    await expect(rail(page)).toBeVisible();
});

test("an open preview does not capture text clicks outside its card", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 700 });
    await mount(page);
    const before = (await button(page).boundingBox())!;
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await expect(rail(page).locator("[data-navigation-rail-preview]")).toBeVisible();
    expect((await button(page).boundingBox())!.width).toBe(before.width);
    const point = { x: before.x - 100, y: before.y + 8 };
    expect(await page.evaluate(({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('[data-testid="markdown-outline-rail"]') === null,
    point)).toBe(true);
    await page.mouse.click(point.x, point.y);
    expect(await page.evaluate(() => window.editorFixture.getView().state.selection.main.empty)).toBe(true);
});
