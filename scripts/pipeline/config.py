# -*- coding: utf-8 -*-
"""Configuration shared by the BioinformaticsHUB 0.4 local analysis runner."""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Sequence, Union


PROTECTED_OUTPUT_ROOT_NAMES: tuple[str, ...] = (
    "archive",
    "data",
    "docs",
    "images",
    "tools",
)


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def assert_not_protected_output(
    out_path: Union[str, Path],
    *,
    root: Optional[Path] = None,
    banned_names: Sequence[str] = PROTECTED_OUTPUT_ROOT_NAMES,
) -> Path:
    """Reject writes beneath repository areas declared read-only by AGENTS.md."""
    out_resolved = Path(out_path).expanduser().resolve()
    base = (root or repo_root()).resolve()
    for name in banned_names:
        banned_path = (base / name).resolve()
        try:
            out_resolved.relative_to(banned_path)
        except ValueError:
            continue
        raise ValueError(f"Refusing to write session artifacts under read-only {name}/: {out_path}")
    try:
        out_resolved.relative_to(base)
    except ValueError:
        # Packaged desktop runs normally live in a user-data directory outside
        # the engine tree, and tests use OS temporary directories.
        pass
    else:
        runs_root = (base / "runs").resolve()
        try:
            out_resolved.relative_to(runs_root)
        except ValueError as exc:
            raise ValueError(
                f"Repository-local session artifacts must be written under runs/: {out_path}"
            ) from exc
    return out_resolved


def default_iqtree_exe() -> Optional[Path]:
    env = os.environ.get("BIOINFORMATICS_HUB_IQTREE")
    if env and Path(env).is_file():
        return Path(env)
    on_path = shutil.which("iqtree2") or shutil.which("iqtree")
    if on_path:
        return Path(on_path)
    root = repo_root()
    candidates = (
        root / "tools" / "iqtree-2.3.6-Windows" / "bin" / "iqtree2.exe",
        root / "tools" / "iqtree-2.3.6-Windows" / "bin" / "iqtree2",
    )
    return next((path for path in candidates if path.is_file()), None)


@dataclass
class PipelineConfig:
    """Small compatibility object consumed only by local, offline steps."""

    gene_id: str
    alias: str = ""
    input_fasta: Optional[Path] = None
    input_kind: str = "auto"
    alignment_fasta: Optional[Path] = None
    out_dir: Optional[Path] = None
    resume: bool = False
    skip_mafft: bool = False
    skip_iqtree: bool = False
    iqtree_exe: Optional[Path] = field(default_factory=default_iqtree_exe)

    def resolve_out(self) -> Path:
        return Path(self.out_dir) if self.out_dir is not None else repo_root() / "runs" / self.gene_id

    def display_name(self) -> str:
        return f"{self.gene_id} ({self.alias})" if self.alias else self.gene_id


STEP_DIRS = {
    "input": "00_input",
    "nucleic": "01_nucleic",
    "physchem": "02_physchem",
    "hydrophobicity": "03_hydrophobicity",
    "msa": "07_msa",
    "tree": "08_tree",
    "itol": "09_local/itol",
}
