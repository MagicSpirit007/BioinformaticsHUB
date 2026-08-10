# -*- coding: utf-8 -*-
"""Nucleic acid composition, ORF check, codon usage."""
from __future__ import annotations

from collections import Counter
from typing import Any, Optional

from ..config import PipelineConfig, STEP_DIRS
from ..utils import ensure_dir, log, write_json

# Standard genetic code codon -> amino acid (one-letter)
CODON_AA = {
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

AA_NAME = {
    "A": "Ala", "C": "Cys", "D": "Asp", "E": "Glu", "F": "Phe",
    "G": "Gly", "H": "His", "I": "Ile", "K": "Lys", "L": "Leu",
    "M": "Met", "N": "Asn", "P": "Pro", "Q": "Gln", "R": "Arg",
    "S": "Ser", "T": "Thr", "V": "Val", "W": "Trp", "Y": "Tyr",
    "*": "Stop",
}

STOP_CODONS = {"TAA", "TAG", "TGA"}


def _reverse_complement(seq: str) -> str:
    """Return a DNA reverse complement while preserving unknown bases as N."""
    table = str.maketrans("ACGTUNacgtun", "TGCAANtgcaan")
    return seq.translate(table)[::-1].upper().replace("U", "T")


def _translate_frame(seq: str, frame: int = 0) -> str:
    seq = seq.upper().replace("U", "T")
    return "".join(
        CODON_AA.get(seq[i : i + 3], "X")
        for i in range(frame, len(seq) - 2, 3)
    )


def _six_frame_orfs(cds: str, min_aa: int = 10) -> dict[str, Any]:
    """Find ATG-to-stop ORFs on all six frames using the standard code.

    This is a deterministic local screening layer, not a claim of byte-for-byte
    equivalence with NCBI ORFfinder (whose start-codon/genetic-code options vary).
    Coordinates are 1-based on the submitted forward strand.
    """
    seq = cds.upper().replace("U", "T")
    n = len(seq)
    found: list[dict[str, Any]] = []
    translations: list[dict[str, Any]] = []

    for strand, source in (("+", seq), ("-", _reverse_complement(seq))):
        for offset in range(3):
            frame_label = offset + 1 if strand == "+" else -(offset + 1)
            translated = _translate_frame(source, offset)
            translations.append(
                {
                    "strand": strand,
                    "frame": frame_label,
                    "translation": translated,
                    "length_aa": len(translated),
                }
            )
            for start in range(offset, len(source) - 2, 3):
                if source[start : start + 3] != "ATG":
                    continue
                stop_at: Optional[int] = None
                for pos in range(start + 3, len(source) - 2, 3):
                    if source[pos : pos + 3] in STOP_CODONS:
                        stop_at = pos
                        break
                if stop_at is None:
                    continue
                aa_len = (stop_at - start) // 3
                if aa_len < min_aa:
                    continue
                if strand == "+":
                    coord_start, coord_end = start + 1, stop_at + 3
                else:
                    coord_start, coord_end = n - (stop_at + 2), n - start
                nt = source[start : stop_at + 3]
                found.append(
                    {
                        "strand": strand,
                        "frame": frame_label,
                        "start": coord_start,
                        "end": coord_end,
                        "length_bp": len(nt),
                        "coding_aa": aa_len,
                        "start_codon": "ATG",
                        "stop_codon": source[stop_at : stop_at + 3],
                        "complete": True,
                        "protein": _translate_frame(nt)[:-1],
                    }
                )

    found.sort(key=lambda x: (-int(x["length_bp"]), str(x["strand"]), int(x["start"])))
    return {
        "genetic_code": 1,
        "minimum_aa": min_aa,
        "orf_count": len(found),
        "longest_orf": found[0] if found else None,
        "orfs": found,
        "frame_translations": translations,
        "method": "Local six-frame ATG-to-stop scan (standard genetic code)",
        "provider_note": "Use NCBI ORF Finder for configurable alternative starts/genetic codes.",
    }


def _gc_by_codon_position(cds: str) -> dict[str, Optional[float]]:
    seq = cds.upper().replace("U", "T")
    values: dict[str, Optional[float]] = {}
    for offset in range(3):
        bases = [seq[i] for i in range(offset, len(seq), 3) if seq[i] in "ACGT"]
        gc = sum(1 for b in bases if b in "GC")
        values[f"gc{offset + 1}_percent"] = round(100.0 * gc / len(bases), 2) if bases else None
    return values


def _base_stats(cds: str) -> dict[str, Any]:
    cds = cds.upper().replace("U", "T")
    n = len(cds)
    counts = {b: cds.count(b) for b in "ATGC"}
    other = n - sum(counts.values())
    pct = {b: round(100.0 * counts[b] / n, 2) if n else 0.0 for b in "ATGC"}
    gc = counts["G"] + counts["C"]
    at = counts["A"] + counts["T"]
    purine = counts["A"] + counts["G"]
    pyrimidine = counts["C"] + counts["T"]
    return {
        "length_bp": n,
        "counts": counts,
        "percent": pct,
        "other_bases": other,
        "gc_count": gc,
        "gc_percent": round(100.0 * gc / n, 2) if n else 0.0,
        "at_percent": round(100.0 * at / n, 2) if n else 0.0,
        "purine_percent": round(100.0 * purine / n, 2) if n else 0.0,
        "pyrimidine_percent": round(100.0 * pyrimidine / n, 2) if n else 0.0,
    }


def _orf_info(cds: str, protein_len: Optional[int], stop_codon: str) -> dict[str, Any]:
    cds = cds.upper().replace("U", "T")
    n = len(cds)
    starts_with_atg = cds.startswith("ATG")
    ends_with_stop = stop_codon in ("TAA", "TAG", "TGA") or (
        n >= 3 and cds[-3:] in ("TAA", "TAG", "TGA")
    )
    if not stop_codon and n >= 3 and cds[-3:] in ("TAA", "TAG", "TGA"):
        stop_codon = cds[-3:]
    frame_ok = n % 3 == 0
    aa_expected = (n // 3) - (1 if ends_with_stop else 0)
    translated = _translate_frame(cds)
    internal_stops = [i + 1 for i, aa in enumerate(translated[:-1]) if aa == "*"]
    complete = starts_with_atg and ends_with_stop and frame_ok and not internal_stops
    return {
        "cds_length_bp": n,
        "frame": 1,
        "strand": "+",
        "starts_with_atg": starts_with_atg,
        "stop_codon": stop_codon or (cds[-3:] if n >= 3 else ""),
        "ends_with_stop": ends_with_stop,
        "frame_ok": frame_ok,
        "orf_complete": complete,
        "internal_stop_positions_aa": internal_stops,
        "coding_aa": protein_len if protein_len is not None else aa_expected,
        "note": "Local ORF check (Frame 1, full-length CDS assumption); not NCBI ORF Finder UI.",
    }


def _codon_usage(cds: str) -> dict[str, Any]:
    cds = cds.upper().replace("U", "T")
    # exclude terminal stop from usage table body if present
    codons = [cds[i : i + 3] for i in range(0, len(cds) - 2, 3)]
    if codons and CODON_AA.get(codons[-1]) == "*":
        stop = codons[-1]
        coding = codons[:-1]
    else:
        stop = ""
        coding = codons
    total = len(coding) or 1
    cnt = Counter(coding)
    by_aa: dict[str, list] = {}
    rows = []
    for codon, aa in sorted(CODON_AA.items(), key=lambda x: (x[1], x[0])):
        if aa == "*":
            continue
        c = cnt.get(codon, 0)
        per_k = round(1000.0 * c / total, 2)
        rows.append(
            {
                "amino_acid": AA_NAME.get(aa, aa),
                "aa": aa,
                "codon": codon,
                "count": c,
                "per_thousand": per_k,
            }
        )
        by_aa.setdefault(aa, []).append((codon, c))

    # synonymous fraction, RSCU + preferred
    for row in rows:
        aa = row["aa"]
        group = by_aa.get(aa, [])
        gsum = sum(c for _, c in group) or 1
        row["synonymous_fraction"] = round(row["count"] / gsum, 4)
        observed_group_sum = sum(c for _, c in group)
        expected = (observed_group_sum / len(group)) if group else 0.0
        row["rscu"] = round(row["count"] / expected, 4) if expected else 0.0
    preferred = {}
    preferred_list = []
    rare = []
    unused = []
    for aa, group in by_aa.items():
        best = max(group, key=lambda x: x[1])
        gsum = sum(c for _, c in group) or 1
        preferred[aa] = {
            "codon": best[0],
            "count": best[1],
            "name": AA_NAME.get(aa, aa),
            "synonymous_fraction": round(best[1] / gsum, 4),
        }
        preferred_list.append(
            {
                "aa": aa,
                "name": AA_NAME.get(aa, aa),
                "codon": best[0],
                "count": best[1],
                "synonymous_fraction": round(best[1] / gsum, 4),
            }
        )
        for codon, c in group:
            frac = c / gsum
            if c == 0:
                unused.append({"aa": aa, "name": AA_NAME.get(aa, aa), "codon": codon, "count": 0})
            elif frac <= 0.06 and codon != best[0]:
                rare.append(
                    {
                        "aa": aa,
                        "name": AA_NAME.get(aa, aa),
                        "codon": codon,
                        "count": c,
                        "synonymous_fraction": round(frac, 4),
                    }
                )
    # stop_codon_counts includes the terminal TAA/TAG/TGA when present;
    # sense-codon usage table above still excludes it (coding-only Counter).
    all_codon_cnt = Counter(codons)
    stop_counts = {sc: all_codon_cnt.get(sc, 0) for sc in ("TAA", "TAG", "TGA")}
    return {
        "coding_codons": len(coding),
        "stop_codon": stop,
        "stop_codon_counts": stop_counts,
        "table": rows,
        "preferred_codons": preferred,
        "preferred_codons_list": preferred_list,
        "rare_codons": rare,
        "unused_codons": unused,
        "gc_by_codon_position": _gc_by_codon_position(cds),
        "note": "Local codon counts, synonymous fractions and RSCU (standard genetic code).",
    }


def run_nucleic(
    cfg: PipelineConfig,
    state: Any,
    cds: Optional[str],
    protein: Optional[str],
    stop_codon: str = "",
) -> dict[str, Any]:
    step = "nucleic"
    if not cds:
        state.set_step(step, "skipped", message="No CDS sequence; protein-only input")
        return {"skipped": True}

    if cfg.resume and state.step_ok(step):
        log("[nucleic] resume: already ok")
        return state.results.get("sections", {}).get("nucleic", {})

    state.set_step(step, "running")
    out = ensure_dir(cfg.resolve_out() / STEP_DIRS["nucleic"])

    bases = _base_stats(cds)
    orf = _orf_info(cds, len(protein) if protein else None, stop_codon)
    codon = _codon_usage(cds)
    six_frame = _six_frame_orfs(cds)

    result = {
        "base_composition": bases,
        "orf": orf,
        "six_frame_orfs": six_frame,
        "codon_usage": codon,
        "method": "Local SMS2-style statistics + deterministic six-frame ORF screening",
    }
    write_json(out / "nucleic.json", result)
    # human-readable summary
    summary_lines = [
        f"CDS length: {bases['length_bp']} bp",
        f"GC%: {bases['gc_percent']}",
        f"A/T/G/C %: {bases['percent']['A']}/{bases['percent']['T']}/{bases['percent']['G']}/{bases['percent']['C']}",
        f"ORF complete: {orf['orf_complete']}",
        f"Stop codon: {orf['stop_codon']}",
        f"Protein aa: {orf['coding_aa']}",
        f"Six-frame ORFs (>= {six_frame['minimum_aa']} aa): {six_frame['orf_count']}",
        f"GC1/GC2/GC3%: {codon['gc_by_codon_position']['gc1_percent']}/{codon['gc_by_codon_position']['gc2_percent']}/{codon['gc_by_codon_position']['gc3_percent']}",
    ]
    (out / "summary.txt").write_text("\n".join(summary_lines) + "\n", encoding="utf-8")

    state.set_section("nucleic", result)
    state.set_step(
        step,
        "completed",
        message=f"GC%={bases['gc_percent']}, {bases['length_bp']} bp",
        artifacts=[
            f"{STEP_DIRS['nucleic']}/nucleic.json",
            f"{STEP_DIRS['nucleic']}/summary.txt",
        ],
    )
    log(f"[nucleic] GC%={bases['gc_percent']}, len={bases['length_bp']}")
    return result
