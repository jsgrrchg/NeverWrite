import { expect, test, type Page } from "@playwright/test";
import type {} from "../harness/transcriptFixture";

const browserErrors = new WeakMap<Page, string[]>();

const scroller = '[data-scrollbar-active="true"]';

async function geometry(page: Page, id: string) {
    return page.locator(scroller).evaluate((container, messageId) => {
        const row = container.querySelector<HTMLElement>(`[data-chat-message-id="${messageId}"]`);
        return {
            top: row ? row.getBoundingClientRect().top - container.getBoundingClientRect().top : null,
            scroll: container.scrollTop,
            remaining: container.scrollHeight - container.clientHeight - container.scrollTop,
            space: container.querySelector<HTMLElement>("[data-chat-runway]")!.getBoundingClientRect().height,
        };
    }, id);
}

async function expectHeld(page: Page, id: string) {
    await expect.poll(async () => Math.abs((await geometry(page, id)).top! - 24)).toBeLessThan(2);
}

test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    browserErrors.set(page, errors);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width: 700, height: 760 });
    await page.goto("/transcript.html");
    await expect(page.locator('[data-chat-message-id="history-29"]')).toBeVisible();
});

test.afterEach(async ({ page }) => {
    expect(browserErrors.get(page)).toEqual([]);
});

test("each send reserves a viewport; streaming consumes it and hands off to the tail", async ({ page }) => {
    await page.evaluate(() => window.transcriptFixture.send("first"));
    await expectHeld(page, "first");
    const before = await geometry(page, "first");
    expect(before.space).toBeGreaterThan(400);
    await page.evaluate(() => window.transcriptFixture.reply(3));
    await expectHeld(page, "first");
    await expect.poll(async () => (await geometry(page, "first")).space).toBeLessThan(before.space - 60);
    await page.evaluate(() => window.transcriptFixture.finish());
    await expectHeld(page, "first");
    expect((await geometry(page, "first")).space).toBeGreaterThan(50);

    await page.evaluate(() => window.transcriptFixture.send("second"));
    await expectHeld(page, "second");
    await page.evaluate(() => window.transcriptFixture.reply(35));
    await expect.poll(async () => (await geometry(page, "second")).space).toBe(0);
    await expect.poll(async () => Math.abs((await geometry(page, "second")).remaining)).toBeLessThan(2);
    await page.evaluate(() => window.transcriptFixture.reply(40));
    await expect.poll(async () => Math.abs((await geometry(page, "second")).remaining)).toBeLessThan(2);
});

test("wheel input releases the hold and overflowing output does not pull the reader down", async ({ page }) => {
    await page.evaluate(() => window.transcriptFixture.send("read"));
    await expectHeld(page, "read");
    const before = await geometry(page, "read");
    await page.locator(scroller).hover();
    await page.mouse.wheel(0, -250);
    await expect.poll(async () => (await geometry(page, "read")).scroll).toBeLessThan(before.scroll - 150);
    const reading = await geometry(page, "read");
    expect(reading.space).toBeGreaterThan(400);
    await page.evaluate(() => window.transcriptFixture.reply(40));
    await expect.poll(async () => (await geometry(page, "read")).space).toBe(0);
    expect(Math.abs((await geometry(page, "read")).scroll - reading.scroll)).toBeLessThan(2);
    await page.getByRole("button", { name: "Scroll to bottom" }).click();
    await expect.poll(async () => Math.abs((await geometry(page, "read")).remaining)).toBeLessThan(2);
});

test("resizes the runway with the dock and viewport and restores it without taking control", async ({ page }) => {
    await page.evaluate(() => window.transcriptFixture.send("resize"));
    await expectHeld(page, "resize");
    const original = await geometry(page, "resize");
    await page.evaluate(() => window.transcriptFixture.dock(220));
    await expectHeld(page, "resize");
    await expect.poll(async () => (await geometry(page, "resize")).space).toBeCloseTo(original.space - 100, 0);
    await page.setViewportSize({ width: 420, height: 900 });
    await expectHeld(page, "resize");
    const saved = await geometry(page, "resize");
    await page.evaluate(() => window.transcriptFixture.switchSession("other"));
    await expect(page.locator('[data-chat-message-id="resize"]')).toHaveCount(0);
    await page.evaluate(() => window.transcriptFixture.switchSession("main"));
    await expectHeld(page, "resize");
    expect(Math.abs((await geometry(page, "resize")).space - saved.space)).toBeLessThan(2);
    const restored = await geometry(page, "resize");
    await page.evaluate(() => window.transcriptFixture.reply(40));
    await expect.poll(async () => (await geometry(page, "resize")).space).toBe(0);
    expect(Math.abs((await geometry(page, "resize")).scroll - restored.scroll)).toBeLessThan(2);
});

test("history replay does not reserve space; an empty chat's first send does", async ({ page }) => {
    await page.evaluate(() => window.transcriptFixture.replay("replayed"));
    expect((await geometry(page, "replayed")).space).toBe(0);
    await page.evaluate(() => window.transcriptFixture.switchSession("empty"));
    await expect(page.locator('[data-chat-row]')).toHaveCount(0);
    await page.evaluate(() => window.transcriptFixture.send("initial"));
    await expect.poll(async () => (await geometry(page, "initial")).space).toBeGreaterThan(400);
    expect((await geometry(page, "initial")).top).toBeLessThanOrEqual(24);
    await page.evaluate(() => window.transcriptFixture.reply(3));
    expect((await geometry(page, "initial")).top).toBeLessThanOrEqual(24);
});

test("removing a failed optimistic prompt retires the runway", async ({ page }) => {
    await page.evaluate(() => window.transcriptFixture.send("failed"));
    await expectHeld(page, "failed");
    await page.evaluate(() => window.transcriptFixture.remove("failed"));
    await expect.poll(async () => (await geometry(page, "failed")).space).toBe(0);
});

test("reduced motion anchors immediately and user input interrupts an entry glide", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => window.transcriptFixture.send("reduced"));
    await expectHeld(page, "reduced");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => {
        window.transcriptFixture.send("interrupt");
        requestAnimationFrame(() => document.querySelector('[data-scrollbar-active="true"]')!
            .dispatchEvent(new WheelEvent("wheel", { deltaY: -10 })));
    });
    await page.waitForTimeout(300);
    expect((await geometry(page, "interrupt")).top).toBeGreaterThan(30);
});


test("explicit navigation releases the prompt and prepended history preserves the visible row", async ({ page }) => {
    await page.evaluate(() => window.transcriptFixture.send("navigation"));
    await expectHeld(page, "navigation");
    await page.evaluate(() => window.transcriptFixture.navigate("history-10"));
    await expect.poll(async () => (await geometry(page, "history-10")).top).toBeGreaterThan(200);
    await expect.poll(async () => (await geometry(page, "navigation")).top).toBeGreaterThan(760);
    await page.waitForTimeout(300); // Let the requested native smooth navigation settle.
    const reading = await geometry(page, "history-10");
    await page.evaluate(() => window.transcriptFixture.reply(40));
    await expect.poll(async () => (await geometry(page, "navigation")).space).toBe(0);
    expect(Math.abs((await geometry(page, "history-10")).top! - reading.top!)).toBeLessThan(2);

    await page.evaluate(() => window.transcriptFixture.enableHistory());
    await page.locator(scroller).evaluate((container) => { container.scrollTop = 90; });
    await expect(page.locator('[data-chat-message-id="older"]')).toHaveCount(1);
    // Original first row stays at its prior screen offset after the page is inserted.
    await expect.poll(async () => (await geometry(page, "history-0")).top).toBeLessThan(0);
    expect((await geometry(page, "history-0")).top).toBeGreaterThan(-90);
});


test("search can take control after a send even when the find bar was already open", async ({ page }) => {
    await page.evaluate(() => window.transcriptFixture.find());
    const search = page.getByRole("textbox", { name: "Find in chat", exact: true });
    await expect(search).toBeVisible();
    await page.evaluate(() => window.transcriptFixture.send("search"));
    await expectHeld(page, "search");
    await search.fill("Earlier message 10.");
    await expect.poll(async () => (await geometry(page, "history-10")).top).toBeGreaterThan(100);
    await page.waitForTimeout(400);
    const reading = await geometry(page, "history-10");
    await page.evaluate(() => window.transcriptFixture.reply(40));
    await expect.poll(async () => (await geometry(page, "search")).space).toBe(0);
    expect(Math.abs((await geometry(page, "history-10")).top! - reading.top!)).toBeLessThan(2);
});

test("a send rolled back before paint does not leave an active anchor", async ({ page }) => {
    await page.evaluate(() => {
        window.transcriptFixture.send("rollback");
        window.transcriptFixture.remove("rollback");
    });
    await expect(page.locator('[data-chat-message-id="rollback"]')).toHaveCount(0);
    await expect.poll(async () => (await geometry(page, "rollback")).space).toBe(0);
    await page.evaluate(() => window.transcriptFixture.send("retry"));
    await expectHeld(page, "retry");
});

async function readAt(page: Page, id: string) {
    await page.locator(scroller).evaluate(async (container, messageId) => {
        container.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
        const row = container.querySelector<HTMLElement>(`[data-chat-message-id="${messageId}"]`)!;
        container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top + 10;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }, id);
}

test("a cached reading anchor survives resize, growth above it and removal", async ({ page }) => {
    await page.evaluate(() => window.transcriptFixture.send("cached"));
    await expectHeld(page, "cached");
    await page.evaluate(() => window.transcriptFixture.reply(40));
    await expect.poll(async () => (await geometry(page, "cached")).space).toBe(0);
    await readAt(page, "history-10");
    const before = await geometry(page, "history-10");
    await page.setViewportSize({ width: 420, height: 900 });
    await expect.poll(async () => Math.abs((await geometry(page, "history-10")).top! - before.top!)).toBeLessThan(2);

    // Async growth above the reader (e.g. an image or expanded activity) must
    // still correct the anchor even though there is no React message update.
    await page.locator('[data-chat-message-id="history-2"]').evaluate((row) => {
        (row as HTMLElement).style.height = "400px";
    });
    await expect.poll(async () => Math.abs((await geometry(page, "history-10")).top! - before.top!)).toBeLessThan(2);
    await page.evaluate(() => window.transcriptFixture.remove("history-10"));
    await expect(page.locator('[data-chat-message-id="history-10"]')).toHaveCount(0);
    const replacement = await geometry(page, "history-11");
    await page.evaluate(() => window.transcriptFixture.reply(45));
    await expect.poll(async () => Math.abs((await geometry(page, "history-11")).top! - replacement.top!)).toBeLessThan(2);
});

test("streaming does not remeasure unrelated offscreen rows to remember the anchor", async ({ page }) => {
    await page.evaluate(() => window.transcriptFixture.send("bounded-work"));
    await expectHeld(page, "bounded-work");
    async function countOffscreenReads(startParagraphs: number) {
        return page.evaluate(async (start) => {
            const original = Element.prototype.getBoundingClientRect;
            let oldRowReads = 0;
            Element.prototype.getBoundingClientRect = function () {
                // This assistant row is neither the reading anchor nor a prompt
                // used by the navigation rail. Token updates need not measure it.
                if (this.getAttribute("data-chat-message-id") === "history-1") oldRowReads++;
                return original.call(this);
            };
            try {
                for (let i = 0; i < 12; i++) {
                    window.transcriptFixture.reply(start + i % 3);
                    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
                }
                return oldRowReads;
            } finally {
                Element.prototype.getBoundingClientRect = original;
            }
        }, startParagraphs);
    }
    expect(await countOffscreenReads(1)).toBe(0);
    await page.evaluate(() => window.transcriptFixture.reply(40));
    await expect.poll(async () => (await geometry(page, "bounded-work")).space).toBe(0);
    await readAt(page, "history-10");
    const before = await geometry(page, "history-10");
    expect(await countOffscreenReads(40)).toBe(0);
    expect(Math.abs((await geometry(page, "history-10")).top! - before.top!)).toBeLessThan(2);
});

test("a row that shrinks out of view hands the anchor to the new visible row", async ({ page }) => {
    await page.evaluate(() => window.transcriptFixture.send("collapse"));
    await expectHeld(page, "collapse");
    await page.evaluate(() => window.transcriptFixture.reply(40));
    await expect.poll(async () => (await geometry(page, "collapse")).space).toBe(0);
    await page.locator('[data-chat-message-id="history-10"]').evaluate((row) => {
        (row as HTMLElement).style.height = "500px";
    });
    await readAt(page, "history-10");
    await page.locator(scroller).evaluate(async (container) => {
        container.scrollTop += 220;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await page.locator('[data-chat-message-id="history-10"]').evaluate((row) => {
        (row as HTMLElement).style.height = "";
    });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const anchor = await page.locator(scroller).evaluate((container) => {
        const top = container.getBoundingClientRect().top;
        const row = Array.from(container.querySelectorAll<HTMLElement>("[data-chat-row]"))
            .find((row) => row.getBoundingClientRect().bottom > top)!;
        return { id: row.dataset.chatMessageId!, offset: row.getBoundingClientRect().top - top };
    });
    expect(anchor.id).not.toBe("history-10");
    await page.setViewportSize({ width: 300, height: 760 });
    await expect.poll(async () => Math.abs((await geometry(page, anchor.id)).top! - anchor.offset)).toBeLessThan(2);
    await page.evaluate(() => window.transcriptFixture.reply(45));
    expect(Math.abs((await geometry(page, anchor.id)).top! - anchor.offset)).toBeLessThan(2);
});
