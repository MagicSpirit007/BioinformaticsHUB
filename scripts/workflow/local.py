"""Execute existing local analysis functions as individual DAG nodes."""
from __future__ import annotations

import contextlib
import hashlib
import json
import sys
from pathlib import Path

from .artifacts import descriptor, scoped, validate_content, fasta_records, write_json


class LocalState:
    def __init__(self):
        self.steps = {}
        self.sections = {}
        self.meta = {}
        self.results = {"sections": self.sections, "meta": self.meta}

    def set_step(self, name, state, **fields):
        self.steps[name] = {"state": state, **fields}

    def set_section(self, name, value):
        self.sections[name] = value

    def set_meta(self, **fields):
        self.meta.update(fields)

    def step_ok(self, name):
        return self.steps.get(name, {}).get("state") in {"ok", "completed"}


def run_local(payload: dict, emit) -> dict:
    from pipeline.config import PipelineConfig
    from pipeline.steps.input_prep import prepare_input

    node, root = payload["node"], Path(payload["runDir"]).resolve()
    work = root / "nodes" / node["id"] / f"attempt-{payload['run']['attempts']}"
    work.mkdir(parents=True, exist_ok=True)
    source = scoped(root, payload["input"]["path"])
    if hashlib.sha256(source.read_bytes()).hexdigest() != payload["input"]["sha256"]:
        raise ValueError("Bound input changed after its checkpoint")
    input_kind = payload["input"]["kind"]
    validate_content(input_kind, source.read_bytes(), aligned=node["tool"] in {"iqtree", "weblogo"})
    cfg = PipelineConfig(gene_id=payload["sessionId"], input_fasta=source, input_kind=node.get("parameters", {}).get("inputKind", {"protein_fasta": "protein", "nucleotide_fasta": "cds"}.get(input_kind, "auto")), out_dir=work)
    state = LocalState()
    cfg.workflow_parameters = node.get("parameters", {})
    emit({"type": "progress", "message": f"Running local {node['tool']}"})
    primary = {}
    with contextlib.redirect_stdout(sys.stderr):
        tool = node["tool"]
        if tool == "prepare":
            prepared = prepare_input(cfg)
            if not prepared.get("protein") and not prepared.get("cds"):
                raise ValueError("No valid sequence produced")
            for kind, name in (("protein_fasta", "protein.fasta"), ("nucleotide_fasta", "cds.fasta")):
                file = work / "00_input" / name
                if file.exists():
                    primary[file.resolve()] = kind
            write_json(work / "input-facts.json", prepared["input"])
        elif tool in {"physchem", "hydrophobicity", "nucleic"}:
            sequence = fasta_records(source.read_text(encoding="utf-8"))[0][1]
            if tool == "physchem":
                from pipeline.steps.physchem import run_physchem
                run_physchem(cfg, state, sequence)
            elif tool == "hydrophobicity":
                from pipeline.steps.hydrophobicity import run_hydrophobicity
                run_hydrophobicity(cfg, state, sequence)
            else:
                from pipeline.steps.nucleic import run_nucleic
                run_nucleic(cfg, state, sequence, None, "")
        elif tool in {"mafft", "weblogo"}:
            from pipeline.steps.msa_weblogo import run_msa_weblogo
            cfg.alignment_fasta = source
            result = run_msa_weblogo(cfg, state, source_fasta=source, run_mafft=tool == "mafft", run_logo=tool == "weblogo")
            if tool == "mafft" and state.step_ok("mafft") and result.get("alignment_path"):
                primary[Path(result["alignment_path"]).resolve()] = "alignment_fasta"
        elif tool == "iqtree":
            from pipeline.steps.iqtree_step import run_iqtree
            result = run_iqtree(cfg, state, alignment_path=source)
            if result.get("newick"):
                primary[(work / result["newick"]).resolve()] = "tree"
        elif tool == "itol":
            from pipeline.steps.itol_export import run_itol_export
            run_itol_export(cfg, state, tree_path=source)
        else:
            raise ValueError("Unknown local tool")
    if node["tool"] != "prepare":
        outcome = state.steps.get(node["tool"], {})
        if outcome.get("state") not in {"completed", "ok"}:
            return {"status": "needs_setup" if outcome.get("state") == "needs_setup" else "failed", "message": outcome.get("message", "Tool produced no verified outcome")}
    write_json(work / "provenance.json", {"parameters": node.get("parameters", {}), "input": payload["input"], "sections": state.sections, "steps": state.steps})
    artifacts = []
    for file in work.rglob("*"):
        if file.is_file() and file.stat().st_size and file.suffix not in {".log", ".ckp"}:
            kind = primary.get(file.resolve(), "report")
            artifacts.append(descriptor(root, file, kind, node["id"], aligned=kind == "alignment_fasta"))
    return {"status": "succeeded", "artifacts": artifacts, "completeness": {"visual": "not_applicable", "downloads": "complete"}, "evidence": {"verified": True, "method": "local-tool-and-artifact-validation", "parameters": node.get("parameters", {})}, "message": "Local artifacts verified"}
