"""Deterministic artifact validation; no model may certify its own output."""
from __future__ import annotations

import hashlib
import json
import math
import re
import shlex
from pathlib import Path

MAX_BYTES = 64 * 1024 * 1024


def scoped(root: Path, relative: str) -> Path:
    if not relative or Path(relative).is_absolute():
        raise ValueError("Artifact must have a relative path")
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root.resolve()) or candidate == root.resolve():
        raise ValueError("Artifact path escapes run")
    return candidate


def fasta_records(text: str) -> list[tuple[str, str]]:
    records = []
    for chunk in text.strip().split(">"):
        if not chunk.strip():
            continue
        lines = chunk.splitlines()
        if len(lines) < 2 or not lines[0].strip():
            raise ValueError("Malformed FASTA")
        seq = "".join(lines[1:]).replace(" ", "").replace("\t", "").upper()
        if not seq or not re.fullmatch(r"[A-Z*.-]+", seq):
            raise ValueError("Invalid FASTA sequence")
        records.append((lines[0].strip(), seq))
    if not text.lstrip().startswith(">") or not records:
        raise ValueError("Expected FASTA")
    return records


def validate_content(kind: str, data: bytes, *, aligned: bool = False) -> dict:
    if not data or len(data) > MAX_BYTES:
        raise ValueError("Empty artifact or size limit exceeded (64 MiB)")
    if kind == "report":
        return {"bytes": len(data)}
    text = data.decode("utf-8-sig")
    if re.search(r"<(!doctype|html|body)\b", text, re.I):
        raise ValueError("HTML is not a scientific data artifact")
    if kind in {"sequence", "protein_fasta", "nucleotide_fasta", "alignment_fasta"}:
        records = fasta_records(text)
        if kind != "alignment_fasta" and len(records) != 1:
            raise ValueError("This workflow accepts one research object; use the alignment input for multiple sequences")
        if kind == "alignment_fasta" and len(records) < 2:
            raise ValueError("Alignment input requires at least two sequences")
        alphabet = set("ACGTRYSWKMBDHVNU") if kind == "nucleotide_fasta" else set("ACDEFGHIKLMNPQRSTVWYBXZJUO*.-")
        if kind != "sequence" and any(set(seq) - alphabet for _, seq in records):
            raise ValueError(f"Invalid alphabet for {kind}")
        if aligned and len({len(seq) for _, seq in records}) != 1:
            raise ValueError("Alignment rows have different lengths")
        return {"records": len(records), "lengths": [len(seq) for _, seq in records]}
    if kind == "identifier":
        value = text.strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{1,99}", value):
            raise ValueError("Provide one explicit accession/identifier")
        return {"identifier": value}
    if kind == "tree":
        stripped = re.sub(r"\[[^\]]*\]", "", text.strip())
        tokens = re.findall(r"'(?:[^']|'')*'|[(),:;]|[^\s(),:;]+", stripped)
        index, leaves = 0, []
        def subtree(depth=0):
            nonlocal index
            if depth > 200 or index >= len(tokens):
                raise ValueError('Malformed Newick tree')
            if tokens[index] == '(':
                index += 1; subtree(depth + 1)
                if index >= len(tokens) or tokens[index] != ',':
                    raise ValueError('Newick internal node needs at least two children')
                while index < len(tokens) and tokens[index] == ',':
                    index += 1; subtree(depth + 1)
                if index >= len(tokens) or tokens[index] != ')':
                    raise ValueError('Malformed Newick parentheses')
                index += 1
                if index < len(tokens) and tokens[index] not in '(),:;':
                    index += 1
            else:
                if tokens[index] in '(),:;':
                    raise ValueError('Empty Newick leaf')
                leaves.append(tokens[index].strip("'").replace("''", "'")); index += 1
            if index < len(tokens) and tokens[index] == ':':
                index += 1
                if index >= len(tokens) or not math.isfinite(float(tokens[index])):
                    raise ValueError('Invalid Newick branch length')
                index += 1
        subtree()
        if index != len(tokens) - 1 or tokens[index] != ';' or len(leaves) < 2:
            raise ValueError("Malformed Newick tree")
        return {"format": "newick", "leaves": leaves}
    if kind == "structure":
        atoms = [line for line in text.splitlines() if line.startswith(("ATOM  ", "HETATM"))]
        if atoms:
            for line in atoms:
                for start, end in ((30, 38), (38, 46), (46, 54)):
                    if not math.isfinite(float(line[start:end])):
                        raise ValueError('Non-finite atomic coordinate')
            return {"format": "pdb", "atoms": len(atoms)}
        if '_atom_site.Cartn_x' in text:
            headers, count = [], 0
            for line in text.splitlines():
                if line.startswith('_atom_site.'):
                    headers.append(line.split()[0])
                elif line.startswith(('ATOM ', 'HETATM ')) and headers:
                    row = shlex.split(line)
                    if len(row) != len(headers):
                        raise ValueError('Truncated mmCIF atom row')
                    for axis in 'xyz':
                        key = '_atom_site.Cartn_' + axis
                        if key not in headers or not math.isfinite(float(row[headers.index(key)])):
                            raise ValueError('Invalid mmCIF coordinate')
                    count += 1
            if count:
                return {'format': 'mmcif', 'atoms': count}
        raise ValueError("Structure has no readable atomic coordinates")
    raise ValueError(f"Unsupported artifact kind: {kind}")


def descriptor(root: Path, file: Path, kind: str, node_id: str, source_url: str | None = None, **options) -> dict:
    file = file.resolve()
    if not file.is_relative_to(root.resolve()):
        raise ValueError("Artifact outside run")
    data = file.read_bytes()
    facts = validate_content(kind, data, **options)
    return {"path": file.relative_to(root.resolve()).as_posix(), "name": file.name, "kind": kind,
            "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "verified": True,
            "producer": node_id, "sourceUrl": source_url, "facts": facts}


def write_json(file: Path, value) -> None:
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
