# -*- coding: utf-8 -*-
"""Normalize a single FASTA input for BioinformaticsHUB local tools and web handoff."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from ..config import PipelineConfig, STEP_DIRS
from ..utils import ensure_dir, is_nucleotide, parse_fasta, translate_cds, write_fasta, write_json


PROTEIN_ALPHABET = set("ACDEFGHIKLMNPQRSTVWY")
DNA_IUPAC = set("ACGTRYSWKMBDHVN")


def _clean_sequence(sequence: str) -> str:
    return re.sub(r"\s+", "", sequence or "").upper()


def prepare_input(cfg: PipelineConfig) -> dict[str, Any]:
    """Prepare input artifacts without creating status/results/session manifests.

    ``input_kind`` is authoritative when explicitly set.  In ``auto`` mode the
    first FASTA record is classified as CDS when at least 85% of its letters are
    A/C/G/T/N, otherwise as protein.  Ambiguous or incomplete CDS properties are
    reported as warnings instead of silently changing frames or genetic codes.
    """
    source = Path(cfg.input_fasta) if cfg.input_fasta else None
    if source is None or not source.is_file():
        raise ValueError("--fasta must point to an existing FASTA file")
    records = parse_fasta(source)
    if not records:
        raise ValueError("Input FASTA contains no records")

    first = records[0]
    sequence = _clean_sequence(first["seq"])
    if not sequence:
        raise ValueError("Input FASTA sequence is empty")

    requested_kind = cfg.input_kind
    if requested_kind not in {"auto", "cds", "protein"}:
        raise ValueError(f"Unsupported input kind: {requested_kind}")
    dna_candidate = sequence.replace("U", "T")
    detected_kind = "cds" if set(dna_candidate) <= DNA_IUPAC or is_nucleotide(sequence) else "protein"
    input_kind = detected_kind if requested_kind == "auto" else requested_kind
    warnings: list[str] = []
    if len(records) > 1:
        warnings.append(
            f"Input FASTA has {len(records)} records; the first record is the primary sequence. "
            "Use --alignment for multi-sequence local tools."
        )
    if requested_kind != "auto" and requested_kind != detected_kind:
        warnings.append(
            f"Explicit input kind '{requested_kind}' overrides automatic classification '{detected_kind}'."
        )

    cds: str | None = None
    protein: str | None = None
    stop_codon: str | None = None
    translation = None

    if input_kind == "cds":
        cds = sequence.replace("U", "T")
        invalid = sorted(set(cds) - DNA_IUPAC)
        if invalid:
            warnings.append(f"CDS contains non-IUPAC symbols: {''.join(invalid)}")
        if len(cds) % 3:
            warnings.append(
                f"CDS length {len(cds)} is not divisible by 3; trailing incomplete codon is ignored."
            )
        if not cds.startswith("ATG"):
            warnings.append("CDS does not start with ATG under the selected first-frame assumption.")
        complete_codon_cds = cds[: len(cds) - (len(cds) % 3)]
        raw_protein, terminal_stop = translate_cds(complete_codon_cds, table=1)
        stop_codon = terminal_stop or None
        internal_stop_positions = [index + 1 for index, aa in enumerate(raw_protein) if aa == "*"]
        if internal_stop_positions:
            warnings.append(
                "CDS translation contains internal stop codons at amino-acid positions "
                + ", ".join(str(value) for value in internal_stop_positions[:12])
                + (" …" if len(internal_stop_positions) > 12 else "")
                + "; protein-dependent tools are not run."
            )
        invalid_protein = sorted(set(raw_protein) - PROTEIN_ALPHABET - {"*"})
        if invalid_protein:
            warnings.append(
                f"Translated protein contains unsupported symbols: {''.join(invalid_protein)}; "
                "protein-dependent tools are not run."
            )
        if not internal_stop_positions and not invalid_protein and raw_protein:
            protein = raw_protein
        translation = {
            "geneticCode": 1,
            "frame": 1,
            "strand": "+",
            "terminalStopCodon": stop_codon,
            "internalStopPositionsAa": internal_stop_positions,
            "rule": "standard genetic code; forward strand; first reading frame",
        }
    else:
        candidate = sequence[:-1] if sequence.endswith("*") else sequence
        internal_stop_positions = [index + 1 for index, aa in enumerate(candidate) if aa == "*"]
        invalid = sorted(set(candidate) - PROTEIN_ALPHABET - {"*"})
        if internal_stop_positions:
            warnings.append(
                "Protein contains internal stop markers at positions "
                + ", ".join(str(value) for value in internal_stop_positions[:12])
                + "; protein-dependent tools are not run."
            )
        if invalid:
            warnings.append(
                f"Protein contains unsupported symbols: {''.join(invalid)}; protein-dependent tools are not run."
            )
        if not internal_stop_positions and not invalid and candidate:
            protein = candidate

    out = ensure_dir(cfg.resolve_out() / STEP_DIRS["input"])
    normalized_path = out / "input.fasta"
    write_fasta(normalized_path, [(first["header_raw"] or cfg.gene_id, sequence)])
    cds_path = None
    protein_path = None
    if cds:
        cds_path = out / "cds.fasta"
        write_fasta(cds_path, [(f"{cfg.gene_id}|CDS", cds)])
    if protein:
        protein_path = out / "protein.fasta"
        write_fasta(protein_path, [(f"{cfg.gene_id}|protein", protein)])

    alignment_copy = None
    alignment_path = Path(cfg.alignment_fasta) if cfg.alignment_fasta else None
    if alignment_path and alignment_path.is_file():
        alignment_copy = out / "alignment.fasta"
        alignment_copy.write_text(
            alignment_path.read_text(encoding="utf-8", errors="replace"),
            encoding="utf-8",
        )

    def relative(path: Path | None) -> str | None:
        return path.relative_to(cfg.resolve_out()).as_posix() if path else None

    payload = {
        "id": cfg.gene_id,
        "geneId": cfg.gene_id,
        "alias": cfg.alias,
        "kind": input_kind,
        "length": len(cds) if cds else len(protein or sequence),
        "inputKind": input_kind,
        "detectedKind": detected_kind,
        # The renderer and research bundle should reference the durable run
        # copy, never Electron's short-lived temp FASTA path.
        "sourceName": source.name,
        "sourcePath": relative(normalized_path),
        "normalizedFastaPath": relative(normalized_path),
        "cdsFastaPath": relative(cds_path),
        "proteinFastaPath": relative(protein_path),
        "alignmentFastaPath": relative(alignment_copy),
        "cdsLengthBp": len(cds) if cds else None,
        "proteinLengthAa": len(protein) if protein else None,
        "hasCds": bool(cds),
        "hasProtein": bool(protein),
        "translation": translation,
        "warnings": warnings,
    }
    write_json(out / "input_meta.json", payload)
    return {"cds": cds, "protein": protein, "alignment_path": alignment_copy, "input": payload}
