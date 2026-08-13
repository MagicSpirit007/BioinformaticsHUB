# BioinformaticsHUB 0.3

> [中文版](./README.md) · [English](README.en.md)

BioinformaticsHUB is a **multi-site aggregation desktop application** for protein and CDS research. It organizes sequences, batch-opens authoritative analysis websites, completes the simplest web form-filling where it is safe to do so, and turns local tools and external results into task records you can keep researching from.

It deliberately does not try to reimplement every website inside the app, nor does it call analysis APIs, assemble "combined conclusions", or generate figures of unclear provenance.

Windows installers and portable builds are available from [GitHub Releases](https://github.com/MagicSpirit007/BioinformaticsHUB/releases). The current release is an unsigned 64-bit build, so Windows SmartScreen may ask you to confirm the publisher manually.

## Product boundaries

Every feature belongs to exactly one of three modes:

| Mode | Behavior |
|---|---|
| `auto_submit` | The app opens the real website, pastes the sequence in the browser and clicks submit, then keeps the official result page |
| `open_only` | The app only opens the official input page; the researcher chooses models, parameters, or handles CAPTCHAs |
| `local` | Runs inside the bundled local Python engine and writes artifacts into the current task directory |

Currently only **Plant-mPLoc** is `auto_submit`. Its web flow is just "paste FASTA → Submit", and the script uses site-specific locators rather than coordinate clicks. DeepLoc, DeepTMHMM, SignalP, TMHMM, MusiteDeep and any other site exposing version, model, threshold or other parameters are `open_only`.

> Plant-mPLoc's official submission page currently uses HTTP. BioinformaticsHUB marks this clearly on the site card; the sequence is only submitted directly when the researcher selects that site and starts a task.

## Usage

1. Paste a FASTA sequence or choose a local FASTA file.
2. Select websites and local tools.
3. Start the task.
4. BioinformaticsHUB prepares the input, then opens manual websites in batches; Plant-mPLoc proceeds automatically to its official result page.
5. For manual websites, paste the final result-page URL back into the corresponding card.
6. Export `research bundle.md` from the task page for a researcher or an external AI to continue interpreting.

Manual websites open 5 tabs per batch, ~750 ms apart within a batch and ~4 s between batches, to reduce pressure on the browser and the sites. The app never scrapes partial DOM to impersonate an analysis result.

## Website catalog

The site list is maintained in [`apps/bioinformatics-hub/public/site-catalog.json`](./apps/bioinformatics-hub/public/site-catalog.json), read by both the frontend and Electron. Python keeps a separate fixed allow-list for the single automatic site, so catalog edits cannot silently widen the auto-submit scope. The catalog covers the analysis entry points the project currently ships with, including:

- Subcellular localization & membrane topology: Plant-mPLoc, DeepLoc, Cell-PLoc, DeepTMHMM, TMHMM, SignalP, Phobius.
- Structure & function annotation: InterPro, CDD, ScanProsite, IUPred, PSIPRED, JPred.
- Homology, interaction & structure: NCBI BLAST, HMMER, STRING, AlphaFold DB, SWISS-MODEL, PrankWeb.
- Other research entry points: MusiteDeep, eggNOG-mapper, ORF Finder, ESPript, and more.

After a site's pages, fields or buttons change, confirm visually in the browser before updating its script and locators.

## Local tools

The local tools area is independent of the websites area. It currently keeps:

- Sequence preprocessing and type detection; CDS can be translated to protein.
- Nucleic-acid composition, reading-frame and codon statistics.
- Protein physicochemical properties.
- Per-residue curves such as hydrophobicity.
- Bundled official MAFFT 7.526 multiple sequence alignment and local WebLogo.
- IQ-TREE phylogenetic trees.
- iTOL upload package export.

Each tool shows its status, source and file path independently. BioinformaticsHUB does not repackage these artifacts into a unified conclusion or an "image evidence" gallery.

## Task directory

Development mode writes to `runs/<task id>/` by default; installed builds write to `%APPDATA%\BioinformaticsHUB\runs\<task id>\`.

```text
runs/<id>/
  session.json                         # Task source of truth: input, websites, local tools, status & result URLs
  00_input/                            # Normalized FASTA
  01_nucleic/ ... 08_tree/             # Only the selected local tool artifacts
  09_browser/plant_mploc/              # Status records for the auto-submit site
  10_research_handoff/
    research bundle.md                 # Input facts, choices, official result links, local artifact index
```

`research bundle.md` only organizes facts and links — it writes no conclusions, contains no prompts, and calls no large model. Older `runs/` entries are kept as historical records; the new app may mark them as legacy but never rewrites or deletes them.

BioinformaticsHUB does not auto-migrate user data from older versions; old tasks remain in their original directories for manual archiving.

## Development

### Python session engine

```powershell
pip install -r requirements-pipeline.txt
python -m playwright install chromium

python scripts/session_runner.py `
  --fasta path\to\input.fasta `
  --id DEMO `
  --run-dir runs/DEMO `
  --input-kind auto `
  --local-tools nucleic,physchem,hydrophobicity `
  --auto-sites plant_mploc
```

The engine sends JSON events line-by-line on stdout: `input_ready`, `local_update`, `site_update` and `done`. `session.json` is persisted centrally by the Electron main process.

### React and Electron

```powershell
cd apps/bioinformatics-hub
npm run build

cd ..\bioinformatics-hub-desktop
npm test
npm run check
npm run dev
```

## Acceptance

```powershell
# Python offline tests
python -m unittest discover -s tests -p "test_*.py"

# UI
cd apps/bioinformatics-hub
npm run build

# Electron
cd ..\bioinformatics-hub-desktop
npm test
npm run check

# Bundled engine self-check
cd ..\..
packaging\engine\python\python.exe packaging\engine\doctor.py
```

Networked web regression must be run explicitly, never as part of the default offline tests. The success criterion is: Plant-mPLoc reaches the real official result page; other sites stay on the real input page waiting for the researcher to set parameters.

## Windows packaging

```powershell
.\packaging\scripts\build_windows.ps1 -Proxy http://127.0.0.1:7890
```

Outputs land in `apps/bioinformatics-hub-desktop/release/`, including an NSIS installer and a portable build. Full instructions are in [`packaging/README.md`](./packaging/README.md), and third-party tool sources and licenses are in [`packaging/THIRD_PARTY_NOTICES.md`](./packaging/THIRD_PARTY_NOTICES.md).

The public source repository does not commit third-party binaries under `tools/`. To self-build a full installer including IQ-TREE, first place the IQ-TREE 2.3.6 Windows distribution under `tools/iqtree-2.3.6-Windows/` in accordance with its third-party license; official release installers already include locally validated tools.

## Data & permissions

- `archive/completed-analysis/`, `tools/` and existing historical assets are read-only.
- New tasks write only to `runs/`; application code writes only to the agreed areas `scripts/`, `apps/`, `packaging/` and `tests/`.
- No API keys are stored, no analysis API or LLM HTTP is called, and no system-level permanent proxy is written.
- Git is never committed or pushed without an explicit request.

## License

The project's own code is under the [MIT License](./LICENSE), Copyright © 2026 MagicSpirit007. Bundled or invoked third-party components remain under their own licenses; see [`packaging/THIRD_PARTY_NOTICES.md`](./packaging/THIRD_PARTY_NOTICES.md).
