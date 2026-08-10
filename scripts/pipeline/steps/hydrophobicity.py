# -*- coding: utf-8 -*-
"""Local ExPASy ProtScale-style sliding-window profiles."""
from __future__ import annotations

from typing import Any, Optional

from ..config import PipelineConfig, STEP_DIRS
from ..utils import ensure_dir, log, write_json

# Kyte-Doolittle scale
KD = {
    "A": 1.8, "R": -4.5, "N": -3.5, "D": -3.5, "C": 2.5,
    "Q": -3.5, "E": -3.5, "G": -0.4, "H": -3.2, "I": 4.5,
    "L": 3.8, "K": -3.9, "M": 1.9, "F": 2.8, "P": -1.6,
    "S": -0.8, "T": -0.7, "W": -0.9, "Y": -1.3, "V": 4.2,
}

# Curated, commonly used ProtScale-compatible residue scales.  Values are
# embedded so the default workflow remains offline and reproducible.
HOPP_WOODS = {
    "A": -0.5, "R": 3.0, "N": 0.2, "D": 3.0, "C": -1.0,
    "Q": 0.2, "E": 3.0, "G": 0.0, "H": -0.5, "I": -1.8,
    "L": -1.8, "K": 3.0, "M": -1.3, "F": -2.5, "P": 0.0,
    "S": 0.3, "T": -0.4, "W": -3.4, "Y": -2.3, "V": -1.5,
}

ZIMMERMAN_POLARITY = {
    "A": 0.00, "R": 52.00, "N": 3.38, "D": 49.70, "C": 1.48,
    "Q": 3.53, "E": 49.90, "G": 0.00, "H": 51.60, "I": 0.13,
    "L": 0.13, "K": 49.50, "M": 1.43, "F": 0.35, "P": 1.58,
    "S": 1.67, "T": 1.66, "W": 2.10, "Y": 1.61, "V": 0.13,
}

BHASKARAN_FLEXIBILITY = {
    "A": 0.357, "R": 0.529, "N": 0.463, "D": 0.511, "C": 0.346,
    "Q": 0.493, "E": 0.497, "G": 0.544, "H": 0.323, "I": 0.462,
    "L": 0.365, "K": 0.466, "M": 0.295, "F": 0.314, "P": 0.509,
    "S": 0.507, "T": 0.444, "W": 0.305, "Y": 0.420, "V": 0.386,
}

SCALES = {
    "kyte_doolittle": {
        "label": "Kyte-Doolittle hydrophobicity",
        "values": KD,
        "direction": "higher = more hydrophobic",
    },
    "hopp_woods": {
        "label": "Hopp-Woods hydrophilicity",
        "values": HOPP_WOODS,
        "direction": "higher = more hydrophilic",
    },
    "zimmerman_polarity": {
        "label": "Zimmerman polarity",
        "values": ZIMMERMAN_POLARITY,
        "direction": "higher = more polar",
    },
    "bhaskaran_flexibility": {
        "label": "Bhaskaran-Ponnuswamy flexibility",
        "values": BHASKARAN_FLEXIBILITY,
        "direction": "higher = more flexible",
    },
}


def sliding_scale(seq: str, scale: dict[str, float], window: int = 9) -> list[dict]:
    seq = seq.upper()
    half = window // 2
    points = []
    for i in range(len(seq)):
        start = max(0, i - half)
        end = min(len(seq), i + half + 1)
        chunk = seq[start:end]
        vals = [scale.get(a, 0.0) for a in chunk]
        score = sum(vals) / len(vals) if vals else 0.0
        points.append({"position": i + 1, "score": round(score, 4)})
    return points


def sliding_kd(seq: str, window: int = 9) -> list[dict]:
    """Backward-compatible public helper for the original KD profile."""
    return sliding_scale(seq, KD, window=window)


def run_hydrophobicity(
    cfg: PipelineConfig,
    state: Any,
    protein: Optional[str],
    window: int = 9,
) -> dict[str, Any]:
    step = "hydrophobicity"
    if not protein:
        state.set_step(step, "skipped", message="No protein")
        return {"skipped": True}

    if cfg.resume and state.step_ok(step):
        log("[hydrophobicity] resume: already ok")
        return state.results.get("sections", {}).get("hydrophobicity", {})

    state.set_step(step, "running")
    out = ensure_dir(cfg.resolve_out() / STEP_DIRS["hydrophobicity"])
    seq = protein.replace("*", "").upper()
    profiles: dict[str, list[dict]] = {
        key: sliding_scale(seq, item["values"], window=window)
        for key, item in SCALES.items()
    }
    points = profiles["kyte_doolittle"]
    scores = [p["score"] for p in points]

    png_name = "hydrophobicity_kd.png"
    png_path = out / png_name

    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        xs = [p["position"] for p in points]
        fig, axes = plt.subplots(4, 1, figsize=(10, 8.4), dpi=120, sharex=True)
        colors = ("#8b3a2b", "#315c72", "#6f5d37", "#48644b")
        for ax, (key, item), color in zip(axes, SCALES.items(), colors):
            ys = [p["score"] for p in profiles[key]]
            ax.plot(xs, ys, color=color, linewidth=1.05)
            ax.axhline(0, color="#999", linewidth=0.6, linestyle="--")
            ax.set_ylabel(item["label"].split()[0], fontsize=8)
            ax.grid(alpha=0.12, linewidth=0.5)
        axes[-1].set_xlabel("Amino acid position")
        axes[0].set_title(cfg.display_name() + f" protein scale profiles (window={window})")
        axes[-1].set_xlim(1, len(seq))
        fig.tight_layout()
        fig.savefig(png_path)
        plt.close(fig)
        plot_ok = True
    except Exception as e:
        plot_ok = False
        (out / "plot_error.txt").write_text(str(e), encoding="utf-8")
        log(f"[hydrophobicity] plot failed: {e}")

    scale_summaries = {}
    for key, item in SCALES.items():
        vals = [p["score"] for p in profiles[key]]
        scale_summaries[key] = {
            "label": item["label"],
            "direction": item["direction"],
            "mean": round(sum(vals) / len(vals), 4) if vals else None,
            "min": min(vals) if vals else None,
            "max": max(vals) if vals else None,
        }

    result = {
        "window": window,
        "scale": "Kyte-Doolittle",
        "length_aa": len(seq),
        "mean_kd": round(sum(scores) / len(scores), 4) if scores else None,
        "min_kd": min(scores) if scores else None,
        "max_kd": max(scores) if scores else None,
        "scales": scale_summaries,
        "scale_count": len(scale_summaries),
        "method": "Local sliding-window profiles using four published amino-acid scales",
        "points_file": f"{STEP_DIRS['hydrophobicity']}/kd_scores.json",
        "figure": f"{STEP_DIRS['hydrophobicity']}/{png_name}" if plot_ok else None,
    }
    write_json(
        out / "protein_scales.json",
        {
            "window": window,
            "profiles": profiles,
            "scale_metadata": scale_summaries,
        },
    )
    # Keep the original artifact name for report/backward compatibility.
    write_json(out / "kd_scores.json", {"window": window, "points": points})
    write_json(out / "hydrophobicity.json", result)

    state.set_section("hydrophobicity", result)
    arts = [
        f"{STEP_DIRS['hydrophobicity']}/hydrophobicity.json",
        f"{STEP_DIRS['hydrophobicity']}/kd_scores.json",
        f"{STEP_DIRS['hydrophobicity']}/protein_scales.json",
    ]
    if plot_ok:
        arts.append(f"{STEP_DIRS['hydrophobicity']}/{png_name}")
    state.set_step(
        step,
        "completed",
        message=f"{len(scale_summaries)} local ProtScale profiles" + (" + plot" if plot_ok else " (scores only)"),
        artifacts=arts,
    )
    log(f"[hydrophobicity] mean KD={result['mean_kd']}, plot={plot_ok}")
    return result
