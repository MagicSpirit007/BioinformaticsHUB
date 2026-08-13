#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""BioinformaticsHUB 0.5.2 artifact runner.

Electron owns ``session.json``.  This process writes only step artifacts and
emits newline-delimited JSON events on stdout.
"""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import sys
from pathlib import Path
from typing import Any, Iterable

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from browser.plant_mploc import run_plant_mploc  # noqa: E402
from pipeline import __version__ as BIOINFORMATICS_HUB_VERSION  # noqa: E402
from pipeline.config import PipelineConfig, STEP_DIRS, assert_not_protected_output  # noqa: E402
from pipeline.steps.hydrophobicity import run_hydrophobicity  # noqa: E402
from pipeline.steps.input_prep import prepare_input  # noqa: E402
from pipeline.steps.iqtree_step import run_iqtree  # noqa: E402
from pipeline.steps.itol_export import run_itol_export  # noqa: E402
from pipeline.steps.msa_weblogo import run_msa_weblogo  # noqa: E402
from pipeline.steps.nucleic import run_nucleic  # noqa: E402
from pipeline.steps.physchem import run_physchem  # noqa: E402
from pipeline.utils import ensure_dir, safe_id  # noqa: E402


LOCAL_TOOL_ORDER = (
    "nucleic",
    "physchem",
    "hydrophobicity",
    "mafft",
    "weblogo",
    "iqtree",
    "itol",
)
AUTO_SITE_ORDER = ("plant_mploc",)

def _distribution_version(name: str, fallback: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return fallback


BIOPYTHON_RUNTIME_VERSION = _distribution_version("biopython", "")
LOGOMAKER_RUNTIME_VERSION = _distribution_version("logomaker", "")


TOOL_AUDIT: dict[str, dict[str, Any]] = {
    "nucleic": {
        "method": "BioinformaticsHUB deterministic sequence statistics and six-frame ORF scan",
        "parameters": {"geneticCode": 1, "minimumOrfAa": 10, "orfScan": "six-frame ATG-to-stop"},
        "source": "00_input/cds.fasta",
        "version": BIOINFORMATICS_HUB_VERSION,
    },
    "physchem": {
        "method": "Biopython ProtParam with documented local fallback",
        "parameters": {"terminalStopHandling": "strip one terminal marker", "internalStops": "reject"},
        "source": "00_input/protein.fasta",
        "version": BIOPYTHON_RUNTIME_VERSION or f"BioinformaticsHUB {BIOINFORMATICS_HUB_VERSION} fallback",
    },
    "hydrophobicity": {
        "method": "BioinformaticsHUB sliding-window published amino-acid scales",
        "parameters": {
            "window": 9,
            "scales": ["Kyte-Doolittle", "Hopp-Woods", "Zimmerman polarity", "Bhaskaran-Ponnuswamy flexibility"],
        },
        "source": "00_input/protein.fasta",
        "version": BIOINFORMATICS_HUB_VERSION,
    },
    "mafft": {
        "method": "MAFFT executable; no online fallback",
        "parameters": {"strategy": "--auto", "quiet": True, "networkFallback": False},
        "source": "00_input/alignment.fasta",
        "version": "runtime probe pending; supplied by executable",
    },
    "weblogo": {
        "method": "Logomaker information-content logo",
        "parameters": {"matrix": "information", "colorScheme": "chemistry"},
        "source": "00_input/alignment.fasta",
        "version": LOGOMAKER_RUNTIME_VERSION or "not installed; runtime dependency unresolved",
    },
    "iqtree": {
        "method": "IQ-TREE2 ML with ModelFinder and UFBoot",
        "parameters": {
            "sequenceType": "auto-detected from alignment alphabet",
            "model": "MFP",
            "ultrafastBootstrap": 1000,
            "threads": "AUTO",
        },
        "source": "00_input/alignment.fasta",
        "version": "runtime probe pending; supplied by executable",
    },
    "itol": {
        "method": "Newick and iTOL DATASET_TEXT bundle export",
        "parameters": {
            "requires": "08_tree/tree.nwk from IQ-TREE",
            "outputs": ["Newick", "DATASET_TEXT", "ZIP"],
            "networkUpload": False,
        },
        "source": "08_tree/tree.nwk",
        "version": BIOINFORMATICS_HUB_VERSION,
    },
}


def emit_event(event: dict[str, Any]) -> None:
    print(json.dumps(event, ensure_ascii=False, separators=(",", ":")), flush=True)


def _parse_csv(value: str) -> list[str]:
    result: list[str] = []
    for raw in (value or "").split(","):
        item = raw.strip()
        if item and item not in result:
            result.append(item)
    return result


def _artifact_descriptor(value: Any) -> dict[str, str]:
    path = str(value).replace("\\", "/")
    suffix = Path(path).suffix.lower()
    kind = {
        ".png": "image",
        ".jpg": "image",
        ".jpeg": "image",
        ".svg": "image",
        ".json": "data",
        ".fasta": "sequence",
        ".fa": "sequence",
        ".nwk": "tree",
        ".treefile": "tree",
        ".zip": "archive",
        ".txt": "text",
        ".html": "html",
    }.get(suffix, "file")
    return {"path": path, "name": Path(path).name, "kind": kind}


class EventState:
    """In-memory compatibility state for local steps; never writes manifests."""

    STATE_MAP = {"ok": "completed", "fail": "failed", "not_applicable": "needs_setup"}

    def __init__(self, emitter=emit_event):
        self.emitter = emitter
        self.steps: dict[str, dict[str, Any]] = {}
        self.sections: dict[str, Any] = {}
        self.meta: dict[str, Any] = {}
        # Some retained helpers inspect these attributes when resume=True.  The
        # new runner always sets resume=False, and these remain memory-only.
        self.results = {"sections": self.sections, "meta": self.meta}

    def set_step(
        self,
        name: str,
        state: str,
        *,
        message: str = "",
        mode: str | None = None,
        artifacts: list | None = None,
        extra: dict | None = None,
    ) -> None:
        normalized = self.STATE_MAP.get(state, state)
        entry: dict[str, Any] = {"state": normalized, "message": message}
        if artifacts is not None:
            entry["artifacts"] = [_artifact_descriptor(value) for value in artifacts]
        if mode:
            entry["mode"] = mode
        if extra:
            entry.update(extra)
        self.steps[name] = entry
        if name == "input":
            return
        audit = TOOL_AUDIT.get(
            name,
            {
                "method": "local tool",
                "parameters": {},
                "source": "runtime source unavailable",
                "version": "runtime version unavailable",
            },
        )
        source = str(audit["source"])
        version = str(audit["version"])
        parameters = dict(audit.get("parameters") or {})
        if normalized == "needs_setup" and name in {"mafft", "iqtree"}:
            version = "not available; local executable was not resolved"
        event: dict[str, Any] = {
            "type": "local_update",
            "id": name,
            "state": normalized,
            "message": message,
            "parameters": parameters,
            "source": source,
            "version": version,
            "provenance": {"kind": "local", "method": str(audit["method"])},
        }
        if artifacts is not None:
            event["artifacts"] = entry["artifacts"]
        section = self.sections.get(name)
        if isinstance(section, dict):
            executable = section.get("executable") or section.get("exe")
            method = section.get("method")
            if executable:
                event["provenance"]["executable"] = executable
            if method:
                event["provenance"]["method"] = method
            if section.get("version"):
                event["version"] = str(section["version"])
            if section.get("source"):
                event["source"] = str(section["source"]).replace("\\", "/")
            if isinstance(section.get("parameters"), dict):
                event["parameters"] = {**parameters, **section["parameters"]}
        self.emitter(event)

    def set_section(self, key: str, data: Any) -> None:
        self.sections[key] = data

    def set_meta(self, **kwargs: Any) -> None:
        self.meta.update(kwargs)

    def step_ok(self, name: str) -> bool:
        return self.steps.get(name, {}).get("state") == "completed"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="BioinformaticsHUB 0.5.2 local-artifact and approved-site session runner (JSONL stdout)",
    )
    parser.add_argument("--fasta", type=Path, required=True, help="Primary CDS or protein FASTA")
    parser.add_argument("--id", dest="run_id", required=True, help="Run/gene identifier")
    parser.add_argument("--run-dir", type=Path, required=True, help="Artifact directory; session.json is not written")
    parser.add_argument("--alias", default="", help="Optional display alias")
    parser.add_argument("--input-kind", choices=("auto", "cds", "protein"), default="auto")
    parser.add_argument(
        "--local-tools",
        default="",
        help="Comma list: nucleic,physchem,hydrophobicity,mafft,weblogo,iqtree,itol",
    )
    parser.add_argument(
        "--auto-sites",
        default="",
        help="Comma list of approved fixed-submit sites; currently only plant_mploc",
    )
    parser.add_argument(
        "--alignment",
        type=Path,
        default=None,
        help="Optional multi-sequence protein FASTA for MAFFT/WebLogo/IQ-TREE",
    )
    return parser


def _validate_selection(selected: Iterable[str], allowed: Iterable[str], label: str) -> None:
    allowed_set = set(allowed)
    unknown = [value for value in selected if value not in allowed_set]
    if unknown:
        raise ValueError(f"Unknown {label}: {', '.join(unknown)}")


def _emit_site(payload: dict[str, Any]) -> None:
    emit_event({"type": "site_update", **payload})


def _run_local_tools(
    cfg: PipelineConfig,
    state: EventState,
    selected: list[str],
    prepared: dict[str, Any],
) -> None:
    cds = prepared.get("cds")
    protein = prepared.get("protein")
    translation = prepared.get("input", {}).get("translation") or {}
    stop_codon = translation.get("terminalStopCodon") or ""

    for tool_id in selected:
        state.set_step(tool_id, "queued", message="Queued")

    if "nucleic" in selected:
        try:
            run_nucleic(cfg, state, cds, protein, stop_codon)
        except Exception as exc:
            state.set_step("nucleic", "failed", message=str(exc))
    if "physchem" in selected:
        try:
            run_physchem(cfg, state, protein)
        except Exception as exc:
            if state.steps.get("physchem", {}).get("state") != "failed":
                state.set_step("physchem", "failed", message=str(exc))
    if "hydrophobicity" in selected:
        if protein:
            try:
                run_hydrophobicity(cfg, state, protein)
            except Exception as exc:
                state.set_step("hydrophobicity", "failed", message=str(exc))
        else:
            state.set_step("hydrophobicity", "failed", message="No valid protein sequence")

    alignment_result: dict[str, Any] = {"alignment_path": None}
    alignment_consumers = {"mafft", "weblogo", "iqtree"}.intersection(selected)
    if alignment_consumers:
        try:
            alignment_result = run_msa_weblogo(
                cfg,
                state,
                source_fasta=cfg.alignment_fasta,
                run_mafft="mafft" in selected,
                run_logo="weblogo" in selected,
            )
        except Exception as exc:
            for tool_id in ("mafft", "weblogo"):
                if tool_id in selected and state.steps.get(tool_id, {}).get("state") not in {
                    "completed",
                    "failed",
                    "needs_setup",
                }:
                    state.set_step(tool_id, "failed", message=str(exc))

    tree_path: Path | None = None
    if "iqtree" in selected:
        raw_alignment = alignment_result.get("alignment_path")
        alignment_path = Path(raw_alignment) if raw_alignment else None
        try:
            result = run_iqtree(cfg, state, alignment_path=alignment_path)
        except Exception as exc:
            state.set_step("iqtree", "failed", message=str(exc))
            result = {"error": str(exc)}
        if isinstance(result, dict) and result.get("newick"):
            tree_path = cfg.resolve_out() / str(result["newick"])
    if "itol" in selected:
        if tree_path is None:
            candidate = cfg.resolve_out() / STEP_DIRS["tree"] / "tree.nwk"
            tree_path = candidate if candidate.is_file() else None
        try:
            run_itol_export(cfg, state, tree_path=tree_path)
        except Exception as exc:
            state.set_step("itol", "failed", message=str(exc))


def _overall(state: EventState, site_states: list[str]) -> str:
    terminal = [entry.get("state") for entry in state.steps.values()] + site_states
    if not terminal:
        return "ok"
    incomplete = {"failed", "needs_setup", "needs_manual", "cancelled"}
    if any(value in incomplete for value in terminal):
        return "partial"
    if any(value in {"running", "queued", "opening", "submitting"} for value in terminal):
        return "partial"
    return "ok"


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    local_tools = _parse_csv(args.local_tools)
    auto_sites = _parse_csv(args.auto_sites)
    try:
        _validate_selection(local_tools, LOCAL_TOOL_ORDER, "local tool id")
        _validate_selection(auto_sites, AUTO_SITE_ORDER, "auto site id")
        run_dir = assert_not_protected_output(args.run_dir, root=ROOT)
        ensure_dir(run_dir)
        cfg = PipelineConfig(
            gene_id=safe_id(args.run_id),
            alias=args.alias,
            input_fasta=args.fasta,
            input_kind=args.input_kind,
            alignment_fasta=args.alignment,
            out_dir=run_dir,
            resume=False,
        )
        prepared = prepare_input(cfg)
        if prepared.get("alignment_path") is not None:
            cfg.alignment_fasta = Path(prepared["alignment_path"])
    except (OSError, ValueError) as exc:
        print(f"Input error: {exc}", file=sys.stderr)
        return 2

    emit_event({"type": "input_ready", "input": prepared["input"]})
    site_states: list[str] = []
    if "plant_mploc" in auto_sites:
        result = run_plant_mploc(
            prepared.get("protein") or "",
            header=cfg.alias or cfg.gene_id,
            artifact_dir=run_dir / "09_browser" / "plant_mploc",
            on_update=_emit_site,
            # Electron owns system-browser tabs. Avoid duplicate tabs from the
            # child process while still returning entry/result URLs in JSONL.
            open_url=lambda _url: None,
        )
        site_states.append(str(result.get("state") or "needs_manual"))

    state = EventState()
    _run_local_tools(cfg, state, local_tools, prepared)
    emit_event({"type": "done", "overall": _overall(state, site_states)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
