# Public workflow fixtures

These are public sequences for a single research object and its downstream analyses, not a batch scheduler. They contain no credentials. Live commands submit them to the selected public services and use the user's configured model routes.

| File | Source / purpose |
|---|---|
| `protein-workflow.json` | [UniProt P69905](https://rest.uniprot.org/uniprotkb/P69905.fasta), human hemoglobin alpha; local preparation and characterization |
| `protein-annotation-workflow.json` | Same sequence; adds InterPro using the verified prepared protein |
| `structure-workflow.json` | Explicit P69905 → AlphaFold UniProt monomer → PrankWeb, AlphaFold prediction model |
| `hemoglobin-orthologs.fasta` | UniProt [P69905](https://www.uniprot.org/uniprotkb/P69905/entry), [P01942](https://www.uniprot.org/uniprotkb/P01942/entry), [P01946](https://www.uniprot.org/uniprotkb/P01946/entry), [P01958](https://www.uniprot.org/uniprotkb/P01958/entry); explicitly chosen human, mouse, rat and horse sequences |
| `evolution-workflow.json` | The four sequences above → MAFFT auto → IQ-TREE MFP/1000 bootstrap/2 threads → iTOL |
| `plant-P10795.fasta` | [UniProt P10795](https://rest.uniprot.org/uniprotkb/P10795.fasta), Arabidopsis chloroplastic Rubisco small subunit; localization tests |
| `HBA1-NM_000558.5.fasta` | [NCBI NM_000558.5](https://www.ncbi.nlm.nih.gov/nuccore/NM_000558.5), human HBA1 mRNA; nucleotide tests |

Retrieved 2026-09-20 from the cited official resources. Sequence headers retain source identifiers. Four taxa are a small reproducibility fixture, not a scientifically sufficient phylogenetic study.

```powershell
node scripts/workflow_cli.cjs probe
node scripts/workflow_cli.cjs start tests/fixtures/protein-workflow.json --wait --quiet --summary
node scripts/workflow_cli.cjs start tests/fixtures/protein-annotation-workflow.json --wait --quiet --summary
node scripts/workflow_cli.cjs start tests/fixtures/evolution-workflow.json --wait --quiet --summary
node scripts/workflow_cli.cjs start tests/fixtures/structure-workflow.json --wait --quiet --summary
node scripts/workflow_cli.cjs export <run-id>
```

Supply existing interpreter paths and an external configuration using the desktop settings, or `workflow_cli.cjs settings <json-file>`. The CLI keeps its own settings under `runs/.workflow-cli`; it uses the same scheduler, worker protocol and run format as Electron. A workflow has one controller at a time.

For actual site acceptance, run `node scripts/workflow_cli.cjs acceptance <comma-separated-site-ids> --live --quiet`. It records partial/blocked outcomes and saves checkpoints; it never treats merely opening a website as completion.
