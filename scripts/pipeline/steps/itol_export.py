# -*- coding: utf-8 -*-
"""Create a local iTOL upload bundle; no network upload or API token is used."""
from __future__ import annotations

import re
import zipfile
from pathlib import Path
from typing import Any

from ..config import PipelineConfig, STEP_DIRS
from ..utils import ensure_dir, write_json


def _leaf_labels(newick: str) -> list[str]:
    labels = []
    pattern = r"(?:\(|,)\s*(?:'((?:[^']|'')+)'|\"([^\"]+)\"|([^():;,\s]+))\s*(?=:)"
    for match in re.finditer(pattern, newick):
        label = next((part for part in match.groups() if part is not None), "").strip()
        if match.group(1) is not None:
            label = label.replace("''", "'")
        if label and label not in labels:
            labels.append(label)
    return labels


def run_itol_export(
    cfg: PipelineConfig,
    state: Any,
    *,
    tree_path: Path | None = None,
) -> dict[str, Any]:
    tree = Path(tree_path) if tree_path else cfg.resolve_out() / STEP_DIRS["tree"] / "tree.nwk"
    if not tree.is_file():
        state.set_step(
            "itol",
            "needs_setup",
            message=(
                "iTOL export requires 08_tree/tree.nwk from IQ-TREE; "
                "select IQ-TREE and provide or generate an aligned multi-FASTA"
            ),
        )
        return {"error": "Newick tree missing"}

    state.set_step("itol", "running", message="Preparing local iTOL upload bundle")
    out = ensure_dir(cfg.resolve_out() / STEP_DIRS["itol"])
    newick = tree.read_text(encoding="utf-8", errors="replace").strip()
    if not newick or "(" not in newick or ")" not in newick:
        state.set_step("itol", "failed", message="Newick tree is empty or malformed")
        return {"error": "invalid Newick tree"}

    tree_copy = out / "tree.nwk"
    tree_copy.write_text(newick + ("" if newick.endswith("\n") else "\n"), encoding="utf-8")
    labels = _leaf_labels(newick)
    dataset = [
        "DATASET_TEXT",
        "SEPARATOR TAB",
        f"DATASET_LABEL\t{cfg.display_name()} labels",
        "COLOR\t#5e6b4d",
        "DATA",
        *(f"{label}\t{label}" for label in labels),
    ]
    dataset_path = out / "dataset_text.txt"
    dataset_path.write_text("\n".join(dataset) + "\n", encoding="utf-8")
    readme_path = out / "README.txt"
    readme_path.write_text(
        "Open https://itol.embl.de/ in your browser, upload tree.nwk, then add "
        "dataset_text.txt as a text annotation dataset. BioinformaticsHUB does not upload these files.\n",
        encoding="utf-8",
    )
    bundle_path = out / "itol_bundle.zip"
    with zipfile.ZipFile(bundle_path, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for path in (tree_copy, dataset_path, readme_path):
            bundle.write(path, arcname=path.name)

    relative = lambda path: path.relative_to(cfg.resolve_out()).as_posix()
    result = {
        "method": "local iTOL Newick and DATASET_TEXT bundle",
        "leafCount": len(labels),
        "tree": relative(tree_copy),
        "dataset": relative(dataset_path),
        "bundle": relative(bundle_path),
    }
    result_path = out / "itol.json"
    write_json(result_path, result)
    artifacts = [relative(path) for path in (result_path, tree_copy, dataset_path, readme_path, bundle_path)]
    state.set_section("itol", result)
    state.set_step("itol", "completed", message=f"iTOL bundle prepared for {len(labels)} leaves", artifacts=artifacts)
    return result
