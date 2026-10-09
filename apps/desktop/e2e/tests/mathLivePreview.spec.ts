import { expect, test, type Page } from "@playwright/test";
import type {} from "../harness/editorFixture";

const formulaDoc = String.raw`# Formulas

Inline $x^2$ and $\frac{a}{b}$; prices $20 and $30.

$$E=mc^2$$

$$
\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}
$$

End.`;

// Desktop builds use classic scrollbars; hidden ones would mask stray overflow.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

async function mount(page: Page, content = formulaDoc) {
    await page.evaluate((doc) => window.editorFixture.mount([
        { id: "math", noteId: "math", title: "Formulas", content: doc },
        { id: "other", noteId: "other", title: "Other", content: "# Other\n\nPlain text." },
    ]), content);
    await expect(page.locator(".cm-editor")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
    await page.goto("/editor.html");
    await page.waitForFunction(() => Boolean(window.editorFixture));
});

test("renders inline and display math without converting prices", async ({ page }) => {
    await mount(page);
    await expect(page.locator(".cm-katex-inline")).toHaveCount(2);
    await expect(page.locator(".cm-katex-block .katex-display")).toHaveCount(2);
    await expect(page.locator(".cm-content")).toContainText("prices $20 and $30");
    expect(await page.evaluate(() => window.editorFixture.getView().state.doc.toString())).toBe(formulaDoc);
});

test("aligns inline formulas with the text baseline without stray scrollbars", async ({ page }) => {
    await mount(page, String.raw`# Formulas

Inline $y_1$ and $\frac{p}{q}$, $\sum_{j=1}^n j$, $\sqrt{\frac{a}{b}}$, $x_{gy}$, $\overbrace{a+b}^{n}$ and $$x_1^2$$ gy.

Bad $\badcmd{x}$ end.`);
    await expect(page.locator(".cm-katex-inline")).toHaveCount(8);
    const formulas = await page.locator(".cm-katex-inline").evaluateAll((elements: HTMLElement[]) => elements.map((element) => {
        const probe = () => Object.assign(document.createElement("span"), {
            style: "display:inline-block;width:0;height:0;vertical-align:baseline",
        });
        const outside = probe();
        const inside = probe();
        element.after(outside);
        (element.querySelector(".katex-html .base") ?? element).prepend(inside);
        const offset = inside.getBoundingClientRect().top - outside.getBoundingClientRect().top;
        outside.remove();
        inside.remove();
        return {
            source: element.querySelector("annotation")?.textContent ?? element.textContent,
            offset: Math.round(offset * 10) / 10,
            scrollbar: element.offsetHeight - element.clientHeight,
        };
    }));
    for (const formula of formulas) {
        expect(Math.abs(formula.offset), formula.source!).toBeLessThanOrEqual(0.5);
        expect(formula.scrollbar, formula.source!).toBe(0);
    }
});

test("clicks to edit formulas, types, and reveals them with arrow navigation", async ({ page }) => {
    await mount(page);
    await page.locator(".cm-katex-inline").first().click();
    await expect(page.locator(".cm-katex-inline")).toHaveCount(1);
    await page.keyboard.insertText("2");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".cm-katex-inline")).toHaveCount(2);
    await expect(page.locator(".cm-katex-inline annotation").first()).toHaveText("2x^2");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".cm-katex-inline")).toHaveCount(1);

    await page.locator(".cm-katex-block").first().click();
    await expect(page.locator(".cm-katex-block")).toHaveCount(1);
    await expect(page.locator(".cm-content")).toContainText("$$E=mc^2$$");
});

test("preserves math through tab switches and source/preview toggles", async ({ page }) => {
    await mount(page);
    await expect(page.locator(".katex")).toHaveCount(4);
    await page.getByRole("button", { name: "Other", exact: true }).click();
    await expect(page.locator(".katex")).toHaveCount(0);
    await page.getByRole("button", { name: "Formulas", exact: true }).click();
    await expect(page.locator(".katex")).toHaveCount(4);
    await page.evaluate(() => window.editorFixture.setPreview(false));
    await expect(page.locator(".katex")).toHaveCount(0);
    await expect(page.locator(".cm-content")).toContainText("$$E=mc^2$$");
    await page.evaluate(() => window.editorFixture.setPreview(true));
    await expect(page.locator(".katex")).toHaveCount(4);
    expect(await page.evaluate(() => window.editorFixture.getView().state.doc.toString())).toBe(formulaDoc);
});

for (const theme of ["light", "dark"]) {
    test(`keeps wide formulas scrollable and errors editable in ${theme} mode`, async ({ page }) => {
        await page.setViewportSize({ width: 760, height: 900 });
        await page.evaluate((value) => {
            document.documentElement.classList.toggle("dark", value === "dark");
        }, theme);
        const wide = String.raw`\underbrace{${Array(80).fill("a").join("+")}}_{n}`;
        await mount(page, `# Formulas\n\nInline $${wide}$.\n\n$$${wide}$$\n\n$\\badcommand{x}$\n\nEnd`);
        await expect(page.locator(".cm-katex-block")).toHaveCount(1);
        for (const selector of [".cm-katex-inline:not(.cm-katex-error)", ".cm-katex-block"]) {
            const dimensions = await page.locator(selector).evaluate((element) => ({
                scroll: element.scrollWidth, client: element.clientWidth,
                width: element.getBoundingClientRect().width,
                editor: document.querySelector(".cm-content")!.getBoundingClientRect().width,
            }));
            expect(dimensions.scroll).toBeGreaterThan(dimensions.client);
            expect(dimensions.width).toBeLessThanOrEqual(dimensions.editor);
            await page.locator(selector).evaluate((element) => { element.scrollLeft = 100; });
            expect(await page.locator(selector).evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
        }
        await expect(page.locator(".cm-katex-error")).toHaveText(String.raw`\badcommand{x}`);
        await page.locator(".cm-katex-error").click();
        await expect(page.locator(".cm-katex-error")).toHaveCount(0);
        await expect(page.locator(".cm-content")).toContainText(String.raw`$\badcommand{x}$`);
    });
}

for (const theme of ["light", "dark"]) {
    test(`keeps table formulas inside their cells in ${theme} mode`, async ({ page }) => {
        await page.setViewportSize({ width: 760, height: 900 });
        await page.evaluate((value) => {
            document.documentElement.classList.toggle("dark", value === "dark");
        }, theme);
        const wide = String.raw`\underbrace{${Array(80).fill("a").join("+")}}_{n}`;
        await mount(page, [
            "# Formulas", "",
            "| Name | $\\sum_{j=1}^n j$ |", "| --- | :---: |",
            "| Short | $y_1$ and $\\frac{p}{q}$ gy |", `| Wide | $${wide}$ |`, "| Bad | $\\badcommand{x}$ |",
            "", "End",
        ].join("\n"));
        await expect(page.locator(".cm-lp-table-cell .cm-katex-inline")).toHaveCount(5);
        const formulas = await page.locator(".cm-lp-table-cell .cm-katex-inline:not(.cm-katex-error)")
            .evaluateAll((elements: HTMLElement[]) => elements.map((element) => {
                const probe = () => Object.assign(document.createElement("span"), {
                    style: "display:inline-block;width:0;height:0;vertical-align:baseline",
                });
                const outside = probe();
                const inside = probe();
                element.after(outside);
                (element.querySelector(".katex-html .base") ?? element).prepend(inside);
                const offset = inside.getBoundingClientRect().top - outside.getBoundingClientRect().top;
                outside.remove();
                inside.remove();
                const rect = element.getBoundingClientRect();
                const cell = element.closest(".cm-lp-table-cell")!.getBoundingClientRect();
                return {
                    source: element.querySelector("annotation")?.textContent ?? "",
                    offset: Math.round(offset * 10) / 10,
                    scrollbar: element.offsetHeight - element.clientHeight,
                    overflows: element.scrollWidth > element.clientWidth,
                    inside: rect.left >= cell.left - 0.5 && rect.right <= cell.right + 0.5,
                };
            }));
        expect(formulas.map((formula) => formula.source)).toEqual([
            String.raw`\sum_{j=1}^n j`, "y_1", String.raw`\frac{p}{q}`, wide,
        ]);
        for (const formula of formulas) {
            expect(formula.inside, formula.source).toBe(true);
            expect(Math.abs(formula.offset), formula.source).toBeLessThanOrEqual(0.5);
            expect(formula.overflows, formula.source).toBe(formula.source === wide);
            if (formula.source !== wide) expect(formula.scrollbar, formula.source).toBe(0);
        }
        await expect(page.locator(".cm-lp-table-cell .cm-katex-error")).toHaveText(String.raw`\badcommand{x}`);
    });
}

for (const selector of [".cm-katex-inline", ".cm-katex-block"]) {
    test(`scrolls ${selector} from its scrollbar without revealing its source`, async ({ page }) => {
        await page.setViewportSize({ width: 760, height: 900 });
        const wide = String.raw`\underbrace{${Array(80).fill("a").join("+")}}_{n}`;
        await mount(page, `# Formulas\n\nInline $${wide}$.\n\n$$${wide}$$\n\nEnd`);
        const math = page.locator(selector);
        const box = await math.evaluate((element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            return { right: rect.right, bottom: rect.bottom, bar: element.offsetHeight - element.clientHeight };
        });
        expect(box.bar).toBeGreaterThan(0);
        // Pressing the track near its end pages the formula horizontally.
        await page.mouse.click(box.right - 30, box.bottom - box.bar / 2);
        await expect.poll(() => math.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
        await expect(math).toHaveCount(1);
        expect(await page.evaluate(() => window.editorFixture.getView().state.selection.main.head)).toBe(0);
    });
}

test("types delimiters incrementally and undoes/redoes the source", async ({ page }) => {
    const original = "# Formulas\n\nFormula ";
    await mount(page, original);
    await page.evaluate(() => {
        const view = window.editorFixture.getView();
        view.dispatch({ selection: { anchor: view.state.doc.length } });
        view.focus();
    });
    await page.keyboard.type("$x");
    await expect(page.locator(".katex")).toHaveCount(0);
    await page.keyboard.type("$");
    await expect(page.locator(".katex")).toHaveCount(1);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator(".katex")).toHaveCount(0);
    expect(await page.evaluate(() => window.editorFixture.getView().state.doc.toString())).toBe(original);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(page.locator(".katex")).toHaveCount(1);
    expect(await page.evaluate(() => window.editorFixture.getView().state.doc.toString())).toBe(`${original}$x$`);
});

test("renders late formulas in long notes and restores their scrolled tab", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const content = "# Formulas\n\n" + Array.from({ length: 300 }, (_, i) =>
        `Paragraph ${i}: $x_{${i}}$ and **bold** text.\n\n$$\\frac{${i}}{2}$$\n\n`,
    ).join("") + "End.";
    await mount(page, content);
    // Formulas are recognized in parsed Markdown only. Jumping before background
    // parsing finishes would let late display blocks grow the note under the
    // scroll target.
    await page.waitForFunction(() => {
        const state = window.editorFixture.snapshot();
        return state.parsedLength === state.docLength;
    });
    await page.evaluate(() => {
        const view = window.editorFixture.getView();
        view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
    });
    await expect(page.locator(".cm-katex-inline annotation").last()).toHaveText("x_{299}");
    await expect(page.locator(".cm-katex-block annotation").last()).toHaveText(String.raw`\frac{299}{2}`);
    await page.getByRole("button", { name: "Other", exact: true }).click();
    await page.getByRole("button", { name: "Formulas", exact: true }).click();
    await expect(page.locator(".cm-katex-inline annotation").last()).toHaveText("x_{299}");
    expect(await page.evaluate(() => window.editorFixture.snapshot().scrollTop)).toBeGreaterThan(1000);
    expect(errors).toEqual([]);
});
