# BioinformaticsHUB Desktop 0.5.2

> [中文版](./README.md) · [English](README.en.md)

The Electron desktop layer loads the React task cockpit, validates the website catalog, schedules the system browser, launches the Python session engine, and atomically persists `session.json`.

## Development

```powershell
# Terminal 1: UI
cd apps/bioinformatics-hub
npm run dev

# Terminal 2: Electron
cd ..\bioinformatics-hub-desktop
npm run dev
```

Development prefers the built `packaging/engine` and its portable Python; only when the engine has not been built does it fall back to the repo `scripts/session_runner.py` and the system Python. Installed builds use the same portable engine under `resources/engine/`.

## Formal bridge

The renderer can only use these capabilities through the context-isolated preload:

- `sessionStart` / `sessionCancel` / `loadSession` / `listSessions`
- `openSite` / `saveSiteResult`
- `exportResearchBundle`
- `pickFasta` / `pickAlignment`
- `revealArtifact`
- `setLocale`
- `onSessionUpdate` / `onLog` / `onSessionDone` / `onSessionCancelled` / `onSessionError`

Python stdout must be JSONL events: `input_ready`, `local_update`, `site_update`, `done`. Ordinary logs only enter the log panel from stderr.

## Browser & sessions

- `open_only` sites open 5 per batch, 750 ms apart within a batch and 4 s between batches.
- Only `plant_mploc` may enter the Python `auto_submit` allow-list.
- Python finishing does not mean all manual tabs have opened; the session stays running until the open scheduling settles, and the user can still cancel later tabs.
- Website entry and result URLs must belong to the official origin allowed by `site-catalog.json` (or the custom site's own origin).
- Result pages are opened by the main process via the system browser; the Python child never opens tabs directly.

## File safety

- New sessions write only to the dev repo `runs/` or the installed `%APPDATA%\BioinformaticsHUB\runs\`.
- FASTA is capped at 10 MiB and alignment files at 25 MiB; alignment files must be imported through the file picker and copied into the current run.
- `bioinformatics-hub-artifact:` only reads PNG/JPEG/WebP files that are declared by `session.json`, have a canonical path inside the current run, and are at most 50 MiB.
- "Show in folder" likewise accepts only declared, non-escaping artifacts.
- Old runs are shown only as legacy summaries — not migrated, deleted, or rewritten.

## Testing & build

```powershell
npm test
npm run check

# Repo root
.\packaging\scripts\build_windows.ps1 -Proxy http://127.0.0.1:7890
```

See [`packaging/README.md`](../../packaging/README.md) for release and portable-engine details.
