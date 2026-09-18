# Desktop browser harnesses

Run the dedicated chat pane smoke tests from `apps/desktop`:

```sh
npx playwright install chromium
npx playwright test --config e2e/playwright.config.ts e2e/tests/chatPane.spec.ts
```

`harness/chat.html` mounts the production sidebar, chat pane, composer and history components with an in-memory conversation and a simulated runtime bridge. The tests check composer identity and drafts across movement/hiding, Archive/Undo, document preservation, and narrow history navigation. Light, dark and narrow screenshots are saved in Playwright's test output directory.

This harness does not exercise native windows or a live provider. Session migration, vault isolation, runtime events and editor integration are covered by Vitest; live streaming and native window restoration still require a desktop smoke test.
