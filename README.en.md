# BioinformaticsHUB

[中文](README.md) · [English](README.en.md)

BioHub presents and stores original bioinformatics service pages and files delivered by coding agents. The desktop shows research tasks, thumbnails, saved pages, original attachments, verification state and execution history. Analysis execution remains available to the calling agent through MCP and CLI.

## Use

1. Confirm task storage, Chrome connection and local runtimes in Settings. Windows desktop and WSL clients share the Windows background service.
2. Have the coding agent run analyses and register original result pages and files.
3. Finalize the complete delivery inventory. Analysis validity, figures, archives and downloads have separate checks; missing evidence stays explicit.
4. Open all saved HTML pages together in one controlled Chrome window, or explicitly visit an online original result.
5. Export an `index.html` directory with original pages, resources, figures and attachments. Internal JSON, task configuration and logs stay inside task storage.

The desktop does not provide a workflow builder, sequence-entry form, scientific interpretation or report generation. External reports can be stored as attachments. Supplementary results never overwrite execution failures or silently launch downstream work.

See the [delivery protocol](docs/delivery.md), [AI interfaces](docs/ai-tools.md) and [execution interfaces](docs/workflows.md). All 28 built-in services have adapter definitions; actual availability and external restrictions are documented in the [site acceptance matrix](docs/site-acceptance.md).

## Development

```powershell
cd apps/bioinformatics-hub
npm ci
npm run build
cd ../bioinformatics-hub-desktop
npm ci
npm test
cd ../..
.\.venv-local\Scripts\python.exe -m unittest discover -s tests -v
.\packaging\scripts\build_windows.ps1 -SkipUi
```

The lightweight installer excludes Python, Chrome, analysis tools, personal credentials and run data. Historical tasks remain readable; old evidence without independent checks is displayed as unverified.

Upstream: [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast). [Third-party notices](packaging/THIRD_PARTY_NOTICES.md).
