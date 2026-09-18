# Desktop browser harnesses

Run the editor tab-rendering regressions from `apps/desktop`:

```sh
npx playwright test --config e2e/playwright.config.ts e2e/tests/editorTabRendering.spec.ts
```

`harness/editor.html` mounts the production React editor with in-memory notes and
a simulated runtime bridge. The tests switch between long scrolled Markdown
documents and short notes without focusing the editor. They inspect actual DOM
rectangles to ensure the restored viewport contains text or table widgets, not
just CodeMirror's virtual gaps. On failure they attach a screenshot and document,
viewport, scroll, selection, and DOM snapshots before and after clicking the blank
area. CodeMirror coordinate helpers are deliberately avoided in the assertions:
they can force a measure and hide the regression.

Run the dedicated chat pane smoke tests from `apps/desktop`:

```sh
npx playwright install chromium
npx playwright test --config e2e/playwright.config.ts e2e/tests/chatPane.spec.ts
```

`harness/chat.html` mounts the production sidebar, chat pane, composer and history components with an in-memory conversation and a simulated runtime bridge. The tests check composer identity and drafts across movement/hiding, Archive/Undo, document preservation, and narrow history navigation. Light, dark and narrow screenshots are saved in Playwright's test output directory.

This harness does not exercise native windows or a live provider. Session migration, vault isolation, runtime events and editor integration are covered by Vitest; live streaming and native window restoration still require a desktop smoke test.
