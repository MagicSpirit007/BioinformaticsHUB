# BioinformaticsHUB 0.5.2

> [中文版](./README.md) · [English](README.en.md)

BioinformaticsHUB is a website-first research site integration platform, not an all-in-one analyzer. It:

- Normalizes CDS / protein FASTA and translates CDS locally when needed;
- Batch-opens websites that require the researcher to choose parameters;
- Runs a fixed "paste FASTA → submit → open result" script only for the parameter-less Plant-mPLoc;
- Saves each website's final result link and research notes;
- Runs clearly-sourced local tools and shows parameters and artifacts inside each card;
- Exports a `research bundle.md` that contains no scientific conclusions.

The UI no longer offers API / Key / proxy settings, and it does not generate combined conclusions, a unified evidence gallery, or long AI analysis text.

## Development

```powershell
npm run dev
npm run build
```

Vite generates a static module from the single catalog source `public/site-catalog.json` at build time and copies the JSON to `dist/` as-is, so Electron's `file://` page never depends on `fetch(file://...)`.

## Frontend bridge contract

Main methods: `sessionStart`, `sessionCancel`, `loadSession`, `listSessions`, `openSite`, `saveSiteResult`, `revealArtifact`, `exportResearchBundle`, `pickFasta`, `pickAlignment`.

Session events: `onSessionUpdate`, `onLog`, `onSessionDone`, `onSessionCancelled`, `onSessionError`.

`sessionStart` arguments:

```ts
{
  fastaText: string
  geneId: string
  alias?: string
  inputKind: 'auto' | 'cds' | 'protein'
  siteIds: string[]
  localToolIds: string[]
  alignmentPath?: string
  customSites?: Array<{ id: string; name: string; entryUrl: string; note?: string }>
}
```

Website execution modes are only `open_only` and `auto_submit`. On catalog load, a strict check requires `auto_submit` to be exactly `plant_mploc`.
