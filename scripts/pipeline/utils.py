# -*- coding: utf-8 -*-
"""Shared utilities for the pipeline."""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


AA_STD = set("ACDEFGHIKLMNPQRSTVWY")
AA_EXT = AA_STD | set("XUBZJ*")
NT_STD = set("ACGTN")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def ensure_dir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p


def write_json(path: Path, data: Any, indent: int = 2) -> None:
    ensure_dir(path.parent)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=indent) + "\n",
        encoding="utf-8",
    )


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def safe_id(s: str) -> str:
    """Filesystem-safe identifier."""
    s = s.strip()
    s = re.sub(r"[^\w.\-]+", "_", s, flags=re.UNICODE)
    return s or "gene"


def wrap_seq(seq: str, width: int = 60) -> str:
    return "\n".join(seq[i : i + width] for i in range(0, len(seq), width))


def write_fasta(path: Path, records: list[tuple[str, str]], width: int = 60) -> None:
    ensure_dir(path.parent)
    parts: list[str] = []
    for header, seq in records:
        h = header.lstrip(">").strip()
        parts.append(f">{h}\n")
        clean = re.sub(r"\s+", "", seq)
        for i in range(0, len(clean), width):
            parts.append(clean[i : i + width] + "\n")
    path.write_text("".join(parts), encoding="utf-8")


def parse_fasta(path: Path) -> list[dict]:
    """Parse multi-FASTA into list of dicts with header_raw, seq, accession."""
    records: list[dict] = []
    header: Optional[str] = None
    parts: list[str] = []
    text = path.read_text(encoding="utf-8", errors="replace")
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith(">"):
            if header is not None:
                seq = "".join(parts)
                records.append(_make_rec(header, seq))
            header = line[1:].strip()
            parts = []
        else:
            parts.append(re.sub(r"\s+", "", line.upper()))
    if header is not None:
        records.append(_make_rec(header, "".join(parts)))
    return records


def _make_rec(header: str, seq: str) -> dict:
    accession = header.split()[0].split("|")[0] if header else "unknown"
    return {
        "header_raw": header,
        "accession": accession,
        "seq": seq,
        "length": len(seq),
    }


def is_nucleotide(seq: str) -> bool:
    s = re.sub(r"[^A-Za-z]", "", seq).upper()
    if not s:
        return False
    nt = sum(1 for c in s if c in NT_STD)
    return (nt / len(s)) >= 0.85


def is_protein(seq: str) -> bool:
    s = re.sub(r"[^A-Za-z*]", "", seq).upper()
    if not s:
        return False
    aa = sum(1 for c in s if c in AA_EXT)
    return (aa / len(s)) >= 0.85 and not is_nucleotide(s)


def normalize_protein_seq(seq: str, *, allow_empty: bool = False) -> str:
    """
    Normalize a protein sequence for downstream steps.

    Rules:
    - whitespace removed, uppercased
    - at most one terminal stop marker '*' is stripped
    - any internal '*' is rejected (never silently deleted / concatenated)
    """
    s = re.sub(r"\s+", "", (seq or "")).upper()
    if not s:
        if allow_empty:
            return ""
        raise ValueError("Empty protein sequence")
    if s.endswith("*"):
        s = s[:-1]
    if "*" in s:
        positions = [i + 1 for i, c in enumerate(s) if c == "*"]
        pos_preview = positions[:12]
        more = "" if len(positions) <= 12 else f" (+{len(positions) - 12} more)"
        raise ValueError(
            "Internal stop marker '*' is not allowed "
            f"(positions {pos_preview}{more}); "
            "refusing to delete internal stops and concatenate fragments"
        )
    if not s:
        if allow_empty:
            return ""
        raise ValueError("Protein sequence empty after stripping terminal stop")
    return s


def translate_cds(cds: str, table: int = 1) -> tuple[str, str]:
    """
    Translate CDS to protein.
    Returns (protein_seq_without_terminal_stop, stop_codon_or_empty).

    Only a single terminal stop is stripped. Internal stop codons leave
    '*' in the returned protein; callers must validate with
    normalize_protein_seq before any downstream analysis.
    Uses Biopython if available, else simple standard table.
    """
    cds = re.sub(r"\s+", "", cds).upper().replace("U", "T")
    try:
        from Bio.Seq import Seq

        prot = str(Seq(cds).translate(table=table, to_stop=False))
    except Exception:
        prot = _translate_simple(cds)
    stop = ""
    if prot.endswith("*"):
        # recover stop codon from last triplet
        if len(cds) >= 3 and len(cds) % 3 == 0:
            stop = cds[-3:]
        prot = prot[:-1]
    elif len(cds) >= 3 and len(cds) % 3 == 0:
        last = cds[-3:]
        if last in ("TAA", "TAG", "TGA"):
            stop = last
    return prot, stop


_CODON_TABLE = {
    "TTT": "F", "TTC": "F", "TTA": "L", "TTG": "L",
    "TCT": "S", "TCC": "S", "TCA": "S", "TCG": "S",
    "TAT": "Y", "TAC": "Y", "TAA": "*", "TAG": "*",
    "TGT": "C", "TGC": "C", "TGA": "*", "TGG": "W",
    "CTT": "L", "CTC": "L", "CTA": "L", "CTG": "L",
    "CCT": "P", "CCC": "P", "CCA": "P", "CCG": "P",
    "CAT": "H", "CAC": "H", "CAA": "Q", "CAG": "Q",
    "CGT": "R", "CGC": "R", "CGA": "R", "CGG": "R",
    "ATT": "I", "ATC": "I", "ATA": "I", "ATG": "M",
    "ACT": "T", "ACC": "T", "ACA": "T", "ACG": "T",
    "AAT": "N", "AAC": "N", "AAA": "K", "AAG": "K",
    "AGT": "S", "AGC": "S", "AGA": "R", "AGG": "R",
    "GTT": "V", "GTC": "V", "GTA": "V", "GTG": "V",
    "GCT": "A", "GCC": "A", "GCA": "A", "GCG": "A",
    "GAT": "D", "GAC": "D", "GAA": "E", "GAG": "E",
    "GGT": "G", "GGC": "G", "GGA": "G", "GGG": "G",
}


def _translate_simple(cds: str) -> str:
    aa = []
    for i in range(0, len(cds) - 2, 3):
        codon = cds[i : i + 3]
        aa.append(_CODON_TABLE.get(codon, "X"))
    return "".join(aa)


def log(msg: str) -> None:
    # stdout is reserved for session_runner's machine-readable JSONL protocol.
    print(msg, file=sys.stderr, flush=True)


def log_err(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)
