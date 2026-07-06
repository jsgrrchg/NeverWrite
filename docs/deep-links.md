# Deep Links

NeverWrite registers the `neverwrite` custom URI scheme in packaged desktop
builds. Deep links are handled by Electron main, then routed through renderer
runtime events so vault-aware behavior remains inside the app UI.

## Supported Actions

### `neverwrite://open`

Open an existing file in the currently open vault:

```text
neverwrite://open?path=<url-encoded-vault-path>
```

NeverWrite also accepts the authority-less form:

```text
neverwrite:open?path=<url-encoded-vault-path>
```

The `path` parameter can be:

- A path relative to the current vault root.
- An absolute path, only if it resolves inside the current vault root.

This action is open/reveal only. It must not create files, write to the vault,
launch shell commands, or open arbitrary external paths.

### `neverwrite://clip`

The web clipper fallback uses `neverwrite://clip` when the loopback desktop API
is unavailable. The clipper flow keeps its existing required parameters and
runtime behavior. Prefer the direct desktop API while debugging clip saving; use
deep links to isolate fallback and OS registration issues.

## Line Fragments

`neverwrite://open` supports optional line fragments for text notes:

```text
#L10
#L10-L20
#L10-20
```

When the target is a note, NeverWrite opens the note, centers the start line,
selects the requested range when present, focuses the editor, and briefly
flashes the line. Non-note files can still open, but line fragments are ignored.

Line fragments are normally URL fragments:

```bash
open 'neverwrite://open?path=notes/todo.md#L10-L20'
```

NeverWrite also tolerates a fragment percent-encoded into the `path` value:

```bash
open 'neverwrite://open?path=notes%2Ftodo.md%23L10'
```

Filenames that merely contain `#L<digit>` are not truncated unless the suffix is
a complete line fragment.

## Security Boundary

Deep-link open requests are resolved against the currently open vault:

- Relative paths resolve under the current vault root.
- Absolute paths are accepted only when they are inside the current vault root.
- `.` and `..` traversal segments are collapsed before the vault-boundary check.
- Requests with no open vault, missing paths, paths outside the vault, or files
  that cannot be found show a notice instead of opening anything.

Examples that should be blocked:

```bash
open 'neverwrite://open?path=../secret.txt'
open 'neverwrite://open?path=/etc/passwd'
open 'neverwrite://open?path=/path/outside/vault/outside.md'
```

Examples that can be valid when the resulting file stays inside the vault:

```bash
open 'neverwrite://open?path=notes/../todo.md'
open 'neverwrite://open?path=/path/to/vault/notes/todo.md#L5'
```

## Platform Delivery

macOS delivers custom URI activations through Electron's `open-url` event.
Windows and Linux deliver activations through a second app instance and command
line arguments. Both paths route through the same dispatcher.

Packaged builds register the scheme with the OS. Pure development sessions do
not reliably validate OS-level scheme handling on macOS because Launch Services
may point `neverwrite://` at another installed build or at Electron itself. For
manual QA of a local packaged app, force the target app:

```bash
open -a /path/to/NeverWrite.app 'neverwrite://open?path=notes/todo.md'
```

If Launch Services has stale registration data, re-register the build:

```bash
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /path/to/NeverWrite.app
```

## Manual Examples

With a vault open:

```bash
open 'neverwrite://open?path=notes/todo.md'
open 'neverwrite://open?path=Daily%20Notes%2F2026-07-06.md'
open 'neverwrite://open?path=notes/todo.md#L20'
open 'neverwrite://open?path=notes/todo.md#L10-L20'
open 'neverwrite:open?path=notes/todo.md'
```

For a local QA build, prefer:

```bash
open -a /path/to/NeverWrite.app 'neverwrite://open?path=notes/todo.md#L10-L20'
```

When a command succeeds, there is no success toast. The expected result is that
the target tab opens or becomes active, and line fragments reveal the requested
line or range.

Last updated: July 6, 2026.
