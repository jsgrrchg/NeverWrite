# App Logs

NeverWrite writes local diagnostic logs so crashes and freezes can be debugged
without asking users to start the app from a terminal.

## Log Locations

Logs are stored under Electron's app data directory:

- Windows: `%APPDATA%\NeverWrite\logs\`
- macOS: `~/Library/Application Support/NeverWrite/logs/`
- Linux: `~/.config/NeverWrite/logs/`

The folder contains JSONL files:

- `main.log`: Electron main-process startup, window, IPC, and crash diagnostics.
- `renderer.log`: renderer warnings/errors and enabled debug scopes.
- `native-backend.log`: native backend sidecar startup, stderr, and exit diagnostics.

Each log entry is a single JSON object with a timestamp, source, level, message,
and optional sanitized details.

## Privacy Notes

Logs are intended for technical diagnostics. NeverWrite redacts common
transcript-like fields such as prompts, message bodies, transcripts, tokens, and
secrets before writing structured details.

Logs can still contain technical context such as provider IDs, window labels,
platform information, error messages, executable paths, and timestamps. Review
files before sharing them publicly.

Chat history is separate from app logs and remains inside the vault under:

```text
<vault>/.neverwrite/sessions/
```

Do not upload chat transcripts unless you have reviewed them and are comfortable
sharing their contents.

## Crash Reports

If NeverWrite crashes on Windows and the log files do not contain enough detail,
system reports can still help:

1. Press `Win + R`, run `perfmon /rel`, click the NeverWrite crash, and copy
   "View technical details".
2. Press `Win + R`, run `eventvwr.msc`, then check `Windows Logs` ->
   `Application` for entries mentioning `NeverWrite.exe` or
   `neverwrite-native-backend.exe`.
3. Windows Error Reporting files may exist under:
   `%LOCALAPPDATA%\Microsoft\Windows\WER\ReportArchive`
   or `%LOCALAPPDATA%\Microsoft\Windows\WER\ReportQueue`.
