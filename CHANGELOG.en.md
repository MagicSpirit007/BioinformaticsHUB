# Changelog

> [中文版](./CHANGELOG.md) · [English](./CHANGELOG.en.md)

## 0.5.0 - 2026-08-13

- The installer no longer bundles the local tool engine (Python / MAFFT / IQ-TREE / Playwright Chromium), greatly reducing its size.
- The app auto-detects the user's Python, Python packages, MAFFT, IQ-TREE and Chromium at runtime.
- Graceful degradation when the engine is missing: local tools are marked `needs_setup`, Plant-mPLoc falls back to manual open, and website aggregation keeps working.
- Added a one-step `install_tools.ps1` helper and an in-app engine-detection status display.

## 0.4.0 - 2026-08-13

- Added a built-in Chinese/English language switcher; the entire UI and Electron main-process messages are now bilingual.
- Added user-defined custom sites and categories that render with the same card design and join research sessions like any `open_only` site.
- Added English documentation (`README.en.md`, `design.en.md`, `CHANGELOG.en.md`, and per-app READMEs).

## 0.3.0 - 2026-08-10

- Renamed the product to BioinformaticsHUB across the board.
- Adopted the new name in the frontend, Electron shell, protocol, environment variables and installer branding.
- Kept website aggregation, session management and independent local tool capabilities.
- Provided Windows x64 NSIS installer and portable builds.
