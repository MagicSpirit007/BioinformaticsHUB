# BioinformaticsHUB 0.3 Windows packaging

> [中文版](./README.md) · [English](README.en.md)

This directory packages the React task dashboard, the Electron session scheduler and the portable Python/Playwright engine into a Windows installer and a portable build.

## Artifact layout

```text
packaging/
  cache/                       # Download cache
  engine/                      # Produced by bootstrap_engine.ps1
    python/                    # Embeddable CPython and Python packages
    scripts/                   # session_runner, local tools and browser scripts
    tools/                     # IQ-TREE and official MAFFT Windows packages
    doctor.py
    engine_manifest.json
  playwright-browsers/         # Pinned Chromium
  requirements-engine.txt
  scripts/
    bootstrap_engine.ps1
    build_windows.ps1
    doctor.py
```

After installation, Electron's `resources/` contains:

```text
resources/
  ui/                          # apps/bioinformatics-hub/dist
  engine/                      # packaging/engine
```

Installed tasks default to `%APPDATA%\BioinformaticsHUB\runs\<id>\`; development mode writes to the repo `runs/<id>/`.

## Build

Run from the repo root:

```powershell
# Fully rebuild engine, UI, NSIS and portable
.\packaging\scripts\build_windows.ps1 -Proxy http://127.0.0.1:7890

# Skip the engine when packaging\engine is already confirmed current 0.3
.\packaging\scripts\build_windows.ps1 -SkipEngine

# Build only the engine and UI, no installer
.\packaging\scripts\build_windows.ps1 -SkipInstaller

# Rebuild only the portable engine
.\packaging\scripts\bootstrap_engine.ps1 -Proxy http://127.0.0.1:7890
```

Output:

```text
apps\bioinformatics-hub-desktop\release\
  BioinformaticsHUB-0.3.0-win-x64.exe
  BioinformaticsHUB-0.3.0-portable.exe
  win-unpacked\BioinformaticsHUB.exe
```

## Engine scope

The bundled engine contains:

- `scripts/session_runner.py` session entry point.
- Code for sequence preprocessing, nucleic statistics, protein physicochemical properties and hydrophobicity profiles.
- Official MAFFT 7.526 Windows portable package, WebLogo, IQ-TREE and iTOL export.
- The Playwright Python package and a pinned Chromium, used for Plant-mPLoc web form-filling.

The bundled engine does not include analysis API clients, LLM clients, large third-party databases or desktop software the researcher must install themselves. The MAFFT original package is SHA-256-verified before extraction; sources and licenses are in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

The public source repository does not distribute third-party binaries under `tools/`. A full self-build including IQ-TREE requires first placing the IQ-TREE 2.3.6 Windows distribution under the repo `tools/iqtree-2.3.6-Windows/`; if missing, the build warns and the corresponding tool is marked `needs_setup` at runtime.

## Self-check

```powershell
packaging\engine\python\python.exe packaging\engine\doctor.py
```

doctor checks Python, `session_runner.py`, local tool modules, the Playwright package, Chromium, MAFFT, and optional IQ-TREE.

## Environment variables

| Variable | Meaning |
|---|---|
| `BIOINFORMATICS_HUB_PYTHON` | Override the Python executable |
| `BIOINFORMATICS_HUB_ENGINE` | Override the engine root |
| `BIOINFORMATICS_HUB_RUNS` | Override the task directory root |
| `BIOINFORMATICS_HUB_DEV_URL` | Dev server URL, default `http://127.0.0.1:5173` |
| `BIOINFORMATICS_HUB_USE_DIST=1` | Load the built UI even in development |
| `BIOINFORMATICS_HUB_DEVTOOLS=1` | Open developer tools |

These variables are read only in the current process; build scripts never write system or user environment.

## Acceptance checklist

1. `bootstrap_engine.ps1` completes and doctor returns 0.
2. The bundled Python can run `scripts/session_runner.py` and produce JSONL events.
3. React build, Electron tests and static checks pass.
4. NSIS, portable and `win-unpacked` are all produced.
5. After creating a task, manual websites open; Plant-mPLoc auto-fills and reaches the official result page.
6. Tasks can save a manual result URL and export `10_research_handoff/research bundle.md`.

## electron-builder notes

With Windows Developer Mode disabled, electron-builder may fail to unpack `winCodeSign` because of macOS symlinks. The project disables executable signing edits and identity auto-discovery; if the local cache is still corrupted, clean the corresponding `winCodeSign` cache as the build script suggests and retry. Do not change system-level security settings for this.

The current v0.3.0 artifacts are unsigned, so Windows SmartScreen may show an unknown-publisher prompt. GitHub Releases also provide SHA-256 checksum files for post-download verification.
