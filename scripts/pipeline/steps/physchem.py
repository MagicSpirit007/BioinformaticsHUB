# -*- coding: utf-8 -*-
"""Protein physicochemical properties (ProtParam-style via Biopython)."""
from __future__ import annotations

from typing import Any, Optional

from ..config import PipelineConfig, STEP_DIRS
from ..utils import ensure_dir, log, normalize_protein_seq, write_json


def run_physchem(
    cfg: PipelineConfig,
    state: Any,
    protein: Optional[str],
) -> dict[str, Any]:
    step = "physchem"
    if not protein:
        state.set_step(step, "failed", message="No valid protein sequence")
        raise ValueError("Protein sequence required for physchem")

    if cfg.resume and state.step_ok(step):
        log("[physchem] resume: already ok")
        return state.results.get("sections", {}).get("physchem", {})

    state.set_step(step, "running")
    out = ensure_dir(cfg.resolve_out() / STEP_DIRS["physchem"])
    # Refuse internal stops; strip only a single terminal '*' if present.
    try:
        seq = normalize_protein_seq(protein)
    except ValueError as e:
        state.set_step(step, "failed", message=str(e))
        raise

    try:
        from Bio.SeqUtils.ProtParam import ProteinAnalysis

        pa = ProteinAnalysis(seq)
        mw = pa.molecular_weight()
        pi = pa.isoelectric_point()
        aa_count = pa.count_amino_acids()
        # Biopython API: older get_amino_acids_percent(); newer amino_acids_percent property
        if hasattr(pa, "get_amino_acids_percent"):
            aa_percent = pa.get_amino_acids_percent()
        else:
            aa_percent = dict(pa.amino_acids_percent)
        # values may already be 0–100 or 0–1 depending on version
        sample = next(iter(aa_percent.values()), 0)
        if sample is not None and sample > 1.0:
            aa_percent_pct = {k: round(float(v), 2) for k, v in aa_percent.items()}
        else:
            aa_percent_pct = {k: round(float(v) * 100, 2) for k, v in aa_percent.items()}
        aromaticity = pa.aromaticity()
        instability = pa.instability_index()
        gravy = pa.gravy()
        sec = pa.secondary_structure_fraction()  # helix, turn, sheet
        extinction = pa.molar_extinction_coefficient()
        ext_red, ext_cys = extinction[0], extinction[1]
        # Abs 0.1% (=1 g/L) = ε / MW
        abs_red = round(ext_red / mw, 3) if mw else None
        abs_cys = round(ext_cys / mw, 3) if mw else None
        aliphatic = _aliphatic_index(aa_percent_pct)
        formula = _molecular_formula(aa_count)
        half_life = _n_end_half_life(seq[0] if seq else "M")
        result = {
            "length_aa": len(seq),
            "molecular_weight_da": round(mw, 2),
            "molecular_weight_kda": round(mw / 1000.0, 3),
            "theoretical_pI": round(pi, 2),
            "aromaticity": round(aromaticity, 4),
            "instability_index": round(instability, 2),
            "instability_class": "unstable" if instability >= 40 else "stable",
            "aliphatic_index": aliphatic,
            "gravy": round(gravy, 4),
            "secondary_structure_fraction": {
                "helix": round(sec[0], 4),
                "turn": round(sec[1], 4),
                "sheet": round(sec[2], 4),
            },
            "molar_extinction_reduced": ext_red,
            "molar_extinction_cystines": ext_cys,
            "abs_0_1_percent_reduced": abs_red,
            "abs_0_1_percent_cystines": abs_cys,
            "molecular_formula": formula.get("formula"),
            "atom_composition": formula.get("atoms"),
            "total_atoms": formula.get("total_atoms"),
            "n_terminal": seq[0] if seq else None,
            "estimated_half_life": half_life,
            "amino_acid_count": aa_count,
            "amino_acid_percent": aa_percent_pct,
            "formula_note": "Biopython Bio.SeqUtils.ProtParam + local aliphatic/formula/N-end half-life",
        }
        neg = aa_count.get("D", 0) + aa_count.get("E", 0)
        pos = aa_count.get("R", 0) + aa_count.get("K", 0)
        result["charged_residues"] = {
            "Asp_Glu_negative": neg,
            "Arg_Lys_positive": pos,
        }
    except ImportError:
        # minimal fallback without Biopython
        result = _fallback_physchem(seq)

    write_json(out / "physchem.json", result)
    lines = [
        f"Length: {result['length_aa']} aa",
        f"MW: {result.get('molecular_weight_da')} Da ({result.get('molecular_weight_kda')} kDa)",
        f"pI: {result.get('theoretical_pI')}",
        f"Instability index: {result.get('instability_index')} ({result.get('instability_class')})",
        f"GRAVY: {result.get('gravy')}",
    ]
    (out / "summary.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    state.set_section("physchem", result)
    state.set_step(
        step,
        "completed",
        message=f"pI≈{result.get('theoretical_pI')}, {result['length_aa']} aa",
        artifacts=[
            f"{STEP_DIRS['physchem']}/physchem.json",
            f"{STEP_DIRS['physchem']}/summary.txt",
        ],
    )
    log(f"[physchem] {result['length_aa']} aa, pI={result.get('theoretical_pI')}, MW={result.get('molecular_weight_da')}")
    return result


def _aliphatic_index(aa_percent_pct: dict[str, float]) -> float:
    """Ikai (1980): AI = xA + a*xV + b*(xI + xL); a=2.9, b=3.9; x = mol%."""
    xa = float(aa_percent_pct.get("A", 0) or 0)
    xv = float(aa_percent_pct.get("V", 0) or 0)
    xi = float(aa_percent_pct.get("I", 0) or 0)
    xl = float(aa_percent_pct.get("L", 0) or 0)
    return round(xa + 2.9 * xv + 3.9 * (xi + xl), 2)


def _molecular_formula(aa_count: dict[str, int]) -> dict[str, Any]:
    """Residue atom counts (peptide-bonded); +1 H2O for termini."""
    # free AA atoms, then subtract H2O per peptide bond (n-1 bonds)
    free = {
        "A": (3, 7, 1, 2, 0), "R": (6, 14, 4, 2, 0), "N": (4, 8, 2, 3, 0),
        "D": (4, 7, 1, 4, 0), "C": (3, 7, 1, 2, 1), "E": (5, 9, 1, 4, 0),
        "Q": (5, 10, 2, 3, 0), "G": (2, 5, 1, 2, 0), "H": (6, 9, 3, 2, 0),
        "I": (6, 13, 1, 2, 0), "L": (6, 13, 1, 2, 0), "K": (6, 14, 2, 2, 0),
        "M": (5, 11, 1, 2, 1), "F": (9, 11, 1, 2, 0), "P": (5, 9, 1, 2, 0),
        "S": (3, 7, 1, 3, 0), "T": (4, 9, 1, 3, 0), "W": (11, 12, 2, 2, 0),
        "Y": (9, 11, 1, 3, 0), "V": (5, 11, 1, 2, 0),
    }
    c = h = n = o = s = 0
    nres = 0
    for aa, cnt in aa_count.items():
        if aa not in free or not cnt:
            continue
        ac, ah, an, ao, as_ = free[aa]
        c += ac * cnt
        h += ah * cnt
        n += an * cnt
        o += ao * cnt
        s += as_ * cnt
        nres += cnt
    if nres >= 1:
        # each peptide bond removes H2O
        bonds = nres - 1
        h -= 2 * bonds
        o -= bonds
    atoms = {"C": c, "H": h, "N": n, "O": o, "S": s}
    parts = [f"{el}{atoms[el]}" for el in ("C", "H", "N", "O", "S") if atoms[el]]
    return {
        "formula": "".join(parts) if parts else None,
        "atoms": atoms,
        "total_atoms": sum(atoms.values()),
    }


def _n_end_half_life(n_term: str) -> dict[str, str]:
    """Approximate N-end rule half-lives (ExPASy ProtParam style)."""
    n = (n_term or "M").upper()
    # mammalian reticulocytes (in vitro)
    mam = {
        "M": "30 hours", "A": "4.4 hours", "S": "1.9 hours", "T": "7.2 hours",
        "V": "100 hours", "G": "30 hours", "P": ">20 hours",
    }
    yeast = {
        "M": ">20 hours", "A": ">20 hours", "S": ">20 hours", "T": ">20 hours",
        "V": ">20 hours", "G": ">20 hours", "P": ">20 hours",
    }
    ecoli = {
        "M": ">10 hours", "A": ">10 hours", "S": ">10 hours", "T": ">10 hours",
        "V": ">10 hours", "G": ">10 hours", "P": ">10 hours",
    }
    unstable = set("RFKLNWYDEHQC")
    if n in unstable:
        return {
            "mammalian_reticulocytes_vitro": "2–30 min (destabilizing N-end)",
            "yeast_in_vivo": "2–30 min (destabilizing N-end)",
            "ecoli_in_vivo": "2–30 min (destabilizing N-end)",
            "n_terminal": n,
            "note": "Approximate N-end rule; not a measured half-life",
        }
    return {
        "mammalian_reticulocytes_vitro": mam.get(n, "~hours (approx)"),
        "yeast_in_vivo": yeast.get(n, ">20 hours"),
        "ecoli_in_vivo": ecoli.get(n, ">10 hours"),
        "n_terminal": n,
        "note": "Approximate N-end rule; not a measured half-life",
    }


def _fallback_physchem(seq: str) -> dict[str, Any]:
    """Very rough MW/pI if Biopython missing."""
    mw_table = {
        "A": 89.09, "R": 174.20, "N": 132.12, "D": 133.10, "C": 121.16,
        "E": 147.13, "Q": 146.15, "G": 75.07, "H": 155.16, "I": 131.17,
        "L": 131.17, "K": 146.19, "M": 149.21, "F": 165.19, "P": 115.13,
        "S": 105.09, "T": 119.12, "W": 204.23, "Y": 181.19, "V": 117.15,
    }
    # residue mass = free aa - water
    water = 18.015
    mw = water
    counts: dict[str, int] = {}
    for a in seq:
        counts[a] = counts.get(a, 0) + 1
        mw += mw_table.get(a, 110.0) - water
    return {
        "length_aa": len(seq),
        "molecular_weight_da": round(mw, 2),
        "molecular_weight_kda": round(mw / 1000.0, 3),
        "theoretical_pI": None,
        "amino_acid_count": counts,
        "formula_note": "Fallback without Biopython; install biopython for full ProtParam",
    }
