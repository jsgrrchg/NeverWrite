# Pi runtime

NeverWrite bundles the published `pi-acp` adapter at the exact `0.0.33` version
pinned in this directory, matching the validated Zeron integration. The adapter
runs with NeverWrite's embedded Node runtime; the Pi
CLI itself remains user-managed and must be available as `pi` on `PATH`.

From `apps/desktop`, run `npm run pi:prepare` to build the validated local runtime
under `.cache/pi-runtime`. Release staging performs the same preparation and
copies it to `native-backend/embedded/pi-acp` outside the Electron ASAR.

`NEVERWRITE_PI_ACP_BIN` can override the adapter command for development. When
using the bundled adapter, NeverWrite resolves the user's Pi executable and
passes its absolute path through `PI_ACP_PI_COMMAND`.
