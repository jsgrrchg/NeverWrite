import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type {} from "../harness/editorFixture";

const paragraphs = Array.from(
    { length: 1200 },
    (_, i) => `Paragraph ${i} **bold** and a [link](https://example.com) text.\n\n`,
).join("");
const tables = Array.from(
    { length: 50 },
    (_, i) =>
        `## Section ${i}\n\n| A | B |\n| --- | --- |\n` +
        Array.from({ length: 35 }, (_, j) => `| Cell ${i}:${j} | Value |\n`).join("") +
        "\n",
).join("");

async function snapshot(page: Page) {
    return page.evaluate(() => window.editorFixture.snapshot());
}

async function expectRenderedWithoutClick(page: Page, testInfo: TestInfo) {
    try {
        // Read DOM rectangles, not CodeMirror's coordinate helpers: those
        // force a measure and would accidentally repair the bug under test.
        await expect.poll(async () => {
            const state = await snapshot(page);
            return state.visible.some((element) => element.text?.trim());
        }, { timeout: 2000 }).toBe(true);
        expect((await snapshot(page)).hasFocus).toBe(false);
    } catch (error) {
        await testInfo.attach("before-click.json", {
            body: JSON.stringify(await snapshot(page), null, 2),
            contentType: "application/json",
        });
        await testInfo.attach("blank-editor.png", {
            body: await page.screenshot(),
            contentType: "image/png",
        });
        await page.locator(".cm-scroller").click({ position: { x: 400, y: 300 } });
        await page.evaluate(() => new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        await testInfo.attach("after-click.json", {
            body: JSON.stringify(await snapshot(page), null, 2),
            contentType: "application/json",
        });
        throw error;
    }
}

test.beforeEach(async ({ page }) => {
    await page.goto("/editor.html");
    await page.waitForFunction(() => Boolean(window.editorFixture));
});

for (const [name, body] of Object.entries({ paragraphs, tables })) {
    test(`restores scrolled ${name} without a click after tab switches (#35)`, async ({ page }, testInfo) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.evaluate((content) => window.editorFixture.mount([
            { id: "alpha", noteId: "alpha", title: "Alpha", content: `# Alpha\n\n${content}` },
            { id: "beta", noteId: "beta", title: "Beta", content: "# Beta\n\nOther document." },
        ]), body);
        await expectRenderedWithoutClick(page, testInfo);

        for (const fraction of [0.15, 0.6]) {
            await page.evaluate((value) => {
                const view = window.editorFixture.getView();
                view.scrollDOM.scrollTop =
                    (view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight) * value;
            }, fraction);
            await expect.poll(async () => (await snapshot(page)).viewport.from).toBeGreaterThan(0);
            for (let round = 0; round < 6; round++) {
                await page.getByRole("button", { name: "Beta", exact: true }).click();
                await expectRenderedWithoutClick(page, testInfo);
                await page.getByRole("button", { name: "Alpha", exact: true }).click();
                // Allow the scheduled scroll restoration to run before
                // asserting; the initial top-of-document DOM is not enough.
                await expect.poll(async () => (await snapshot(page)).scrollTop).toBeGreaterThan(500);
                await expectRenderedWithoutClick(page, testInfo);
                expect((await snapshot(page)).docLength).toBe(body.length + "# Alpha\n\n".length);
            }
        }
        expect(errors).toEqual([]);
    });
}
