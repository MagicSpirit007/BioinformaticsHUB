# -*- coding: utf-8 -*-
"""IQ-TREE ML phylogeny + simple SVG/PNG tree figure."""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Optional

from ..config import PipelineConfig, STEP_DIRS, default_iqtree_exe
from ..utils import ensure_dir, log, log_err, parse_fasta, write_json


DNA_IUPAC = set("ACGTUNRYSWKMBDHV")
DNA_CANONICAL = set("ACGTUN")
PROTEIN_IUPAC = set("ACDEFGHIKLMNPQRSTVWYBXZJUO")


def _detect_alignment_sequence_type(records: list[dict]) -> str:
    """Return IQ-TREE's DNA/AA type, rejecting unsafe alphabet guesses."""
    symbols = [
        symbol
        for record in records
        for symbol in str(record.get("seq") or "").upper()
        if symbol not in {"-", ".", "?"}
    ]
    if not symbols:
        raise ValueError("Alignment contains no sequence symbols after removing gaps")
    alphabet = set(symbols)
    invalid = sorted(alphabet - DNA_IUPAC - PROTEIN_IUPAC)
    if invalid:
        raise ValueError(f"Alignment contains unsupported symbols: {''.join(invalid)}")

    canonical_nt_fraction = sum(symbol in DNA_CANONICAL for symbol in symbols) / len(symbols)
    if alphabet <= DNA_IUPAC:
        if canonical_nt_fraction >= 0.85:
            return "DNA"
        raise ValueError(
            "Alignment alphabet is ambiguous between nucleotide and protein; "
            "provide an alignment with at least 85% A/C/G/T/U/N symbols"
        )
    if alphabet <= PROTEIN_IUPAC:
        return "AA"
    raise ValueError("Alignment alphabet could not be classified safely")


def _detect_iqtree_version(executable: Path) -> str:
    path_match = re.search(r"(?i)iqtree[-_]?v?(\d+\.\d+(?:\.\d+)?)", str(executable))
    if path_match:
        return path_match.group(1)
    try:
        process = subprocess.run(
            [str(executable), "--version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
        )
        output = "\n".join((process.stdout, process.stderr))
        match = re.search(r"(?i)(?:version\s+|iq-tree[^0-9]*)(\d+\.\d+(?:\.\d+)?)", output)
        if match:
            return match.group(1)
    except Exception:
        pass
    return "runtime probe unavailable; see executable path"


def run_iqtree(
    cfg: PipelineConfig,
    state: Any,
    *,
    alignment_path: Optional[Path] = None,
) -> dict[str, Any]:
    step = "iqtree"
    if cfg.skip_iqtree:
        state.set_step(step, "skipped", message="--skip-iqtree")
        return {"skipped": True}

    aln = Path(alignment_path) if alignment_path else cfg.resolve_out() / STEP_DIRS["msa"] / "mafft.fasta"
    if not aln.is_file():
        state.set_step(step, "needs_setup", message="IQ-TREE requires an aligned multi-FASTA input")
        return {"error": "no alignment"}

    exe = cfg.iqtree_exe or default_iqtree_exe()
    if exe is None or not Path(exe).is_file():
        # try PATH
        which = shutil.which("iqtree2") or shutil.which("iqtree")
        exe = Path(which) if which else None
    if exe is None or not Path(exe).is_file():
        msg = "iqtree2 not found (checked tools/iqtree-*/bin and PATH)"
        state.set_step(step, "needs_setup", message=msg)
        return {"error": msg}

    state.set_step(step, "running")
    out = ensure_dir(cfg.resolve_out() / STEP_DIRS["tree"])
    work = ensure_dir(out / "iqtree_work")
    recs = parse_fasta(aln)
    if len(recs) < 2:
        state.set_step(step, "failed", message=f"IQ-TREE requires at least 2 aligned sequences, got {len(recs)}")
        return {"error": "too few aligned sequences"}
    try:
        sequence_type = _detect_alignment_sequence_type(recs)
    except ValueError as exc:
        state.set_step(step, "failed", message=str(exc))
        return {"error": str(exc)}
    clean_aln = work / "alignment_iqtree.fasta"
    id_map = work / "taxon_id_map.tsv"
    try:
        rows = _write_clean_fasta(
            recs,
            clean_aln,
            id_map,
            cfg,
            sequence_type=sequence_type,
        )
    except ValueError as exc:
        state.set_step(step, "failed", message=str(exc))
        return {"error": str(exc)}

    prefix = work / "tree"
    parameters = getattr(cfg, "workflow_parameters", {})
    selected_model = parameters.get("model", "MFP")
    bootstrap = str(parameters.get("bootstrap", "1000"))
    threads = str(parameters.get("threads", "AUTO"))
    if selected_model not in {"MFP", "LG+G", "JTT+G", "WAG+G", "GTR+G"} or bootstrap not in {"1000", "2000", "5000"} or threads not in {"AUTO", "1", "2", "4", "8"}:
        raise ValueError("Invalid IQ-TREE workflow parameters")
    cmd = [
        str(exe),
        "-s",
        str(clean_aln),
        "-st",
        sequence_type,
        "-m",
        selected_model,
        "-B",
        bootstrap,
        "-T",
        threads,
        "--prefix",
        str(prefix),
        "-redo",
    ]
    if parameters.get('seed') is not None:
        seed = str(parameters['seed'])
        if not seed.isdigit() or not 1 <= int(seed) <= 2147483647:
            raise ValueError('IQ-TREE seed must be a positive 32-bit integer')
        cmd.extend(['-seed', seed])
    log("[iqtree] " + " ".join(cmd))
    try:
        p = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=7200,
        )
    except Exception as exc:
        state.set_step(step, "failed", message=f"IQ-TREE launch failed: {exc}")
        return {"error": str(exc)}
    (work / "run_log.txt").write_text(
        "CMD: " + " ".join(cmd) + "\n\n=== STDOUT ===\n" + p.stdout + "\n\n=== STDERR ===\n" + p.stderr,
        encoding="utf-8",
    )
    if p.returncode != 0:
        state.set_step(step, "failed", message=f"iqtree rc={p.returncode}")
        log_err(p.stderr[-1500:] if p.stderr else p.stdout[-1500:])
        return {"error": f"rc={p.returncode}", "log": f"{STEP_DIRS['tree']}/iqtree_work/run_log.txt"}

    treefile = Path(str(prefix) + ".treefile")
    if not treefile.is_file():
        state.set_step(step, "failed", message="treefile missing")
        return {"error": "treefile missing"}

    raw_nwk = out / "tree_raw.treefile"
    shutil.copy(treefile, raw_nwk)
    named_nwk = out / "tree.nwk"
    mapping = _restore_names(treefile, id_map, named_nwk, cfg)

    # model info
    model_info = {}
    iq_report = Path(str(prefix) + ".iqtree")
    if iq_report.is_file():
        text = iq_report.read_text(encoding="utf-8", errors="replace")
        for line in text.splitlines():
            if "Best-fit model" in line or "best-fit model" in line.lower():
                model_info["best_fit_model"] = line.strip()
            if "Log-likelihood" in line:
                model_info.setdefault("log_likelihood", line.strip())

    # SVG figure
    svg_path = out / "tree.svg"
    try:
        _newick_to_svg(treefile, svg_path, f"{cfg.display_name()} protein phylogeny", query_id=_query_short_id(rows, cfg))
    except Exception as e:
        log_err(f"[iqtree] svg failed: {e}")
        svg_path = None

    # try PNG via pillow beautify (optional)
    png_path = out / "tree.png"
    try:
        _draw_tree_png(named_nwk, png_path, cfg)
    except Exception as e:
        log_err(f"[iqtree] png failed: {e}")
        png_path = None

    result = {
        "n_taxa": len(rows),
        "exe": str(exe),
        "version": _detect_iqtree_version(Path(exe)),
        "treefile": f"{STEP_DIRS['tree']}/tree_raw.treefile",
        "newick": f"{STEP_DIRS['tree']}/tree.nwk",
        "svg": f"{STEP_DIRS['tree']}/tree.svg" if svg_path and svg_path.is_file() else None,
        "png": f"{STEP_DIRS['tree']}/tree.png" if png_path and Path(png_path).is_file() else None,
        "model": model_info,
        "bootstrap": "UFBoot " + bootstrap,
        "method": "IQ-TREE2 ML + ModelFinder" if selected_model == "MFP" else "IQ-TREE2 ML",
        "sequenceType": sequence_type,
        "parameters": {
            "sequenceType": sequence_type,
            "model": selected_model,
            "ultrafastBootstrap": int(bootstrap),
            "threads": threads,
            "seed": int(parameters['seed']) if parameters.get('seed') is not None else None,
        },
    }
    write_json(out / "iqtree.json", result)
    state.set_section("iqtree", result)
    arts = [result["treefile"], result["newick"]]
    if result["svg"]:
        arts.append(result["svg"])
    if result["png"]:
        arts.append(result["png"])
    state.set_step(step, "completed", message=f"{len(rows)} taxa", artifacts=arts)
    log(f"[iqtree] done taxa={len(rows)}")
    return result


def _query_short_id(rows: list, cfg: PipelineConfig) -> str:
    for sid, h, _ in rows:
        if "query" in h.lower() or h.startswith(cfg.gene_id):
            return sid
    return rows[0][0] if rows else "query"


def _write_clean_fasta(
    recs,
    clean_aln: Path,
    id_map: Path,
    cfg: PipelineConfig,
    *,
    sequence_type: str,
):
    used: set[str] = set()
    rows = []
    lengths = {len(r["seq"]) for r in recs}
    if len(lengths) != 1:
        raise ValueError(f"Alignment lengths differ: {sorted(lengths)[:5]}")
    with clean_aln.open("w", encoding="utf-8") as fh, id_map.open("w", encoding="utf-8") as mp:
        mp.write("short_id\toriginal_header\tungapped_len\n")
        for r in recs:
            h, s = r["header_raw"], r["seq"]
            if sequence_type == "DNA":
                s = s.upper().replace("U", "T")
            sid = _short_id(h, used, cfg)
            ug = len(s.replace("-", "").replace(".", ""))
            rows.append((sid, h, s))
            safe_header = re.sub(r"[\t\x00-\x1f\x7f]+", " ", h).strip()
            mp.write(f"{sid}\t{safe_header}\t{ug}\n")
            fh.write(f">{sid}\n")
            for i in range(0, len(s), 70):
                fh.write(s[i : i + 70] + "\n")
    return rows


def _short_id(header: str, used: set[str], cfg: PipelineConfig) -> str:
    acc = header.split("|")[0].strip()
    if "query" in header.lower() or header.startswith(cfg.gene_id):
        base = f"{cfg.alias or cfg.gene_id}_query"
    else:
        base = acc
    base = re.sub(r"[^A-Za-z0-9_.-]", "_", base)[:40]
    name = base or "seq"
    i = 2
    while name in used:
        name = f"{base}_{i}"
        i += 1
    used.add(name)
    return name


def _restore_names(treefile: Path, id_map: Path, out_nwk: Path, cfg: PipelineConfig) -> dict:
    mapping = {}
    for line in id_map.read_text(encoding="utf-8").splitlines()[1:]:
        if not line.strip():
            continue
        parts = line.split("\t")
        sid, full = parts[0], parts[1]
        if "query" in full.lower() or sid.endswith("_query"):
            mapping[sid] = f"{cfg.alias or cfg.gene_id}_{cfg.gene_id}"
        else:
            toks = full.split("|")
            acc = toks[0]
            sp = "unknown"
            for t in toks:
                if "_" in t and t[0].isalpha() and not t.endswith("aa"):
                    if "protein" not in t.lower() and "finger" not in t.lower():
                        sp = t
            mapping[sid] = f"{acc}_{sp}" if sp != "unknown" else acc
    nwk = treefile.read_text(encoding="utf-8").strip()
    for sid in sorted(mapping.keys(), key=len, reverse=True):
        pattern = rf"(?P<prefix>(?:^|[(,])\s*){re.escape(sid)}(?=:)"
        quoted = _quote_newick_label(mapping[sid])
        nwk = re.sub(pattern, lambda match: match.group("prefix") + quoted, nwk)
    out_nwk.write_text(nwk + ("\n" if not nwk.endswith("\n") else ""), encoding="utf-8")
    return mapping


def _quote_newick_label(value: str) -> str:
    """Quote a leaf label so FASTA punctuation cannot become Newick syntax."""
    normalized = re.sub(r"[\x00-\x1f\x7f]+", " ", str(value or "")).strip() or "unnamed"
    return "'" + normalized.replace("'", "''") + "'"


# ---- minimal Newick SVG (from historical run_iqtree script, parameterized) ----

class Node:
    __slots__ = ("name", "dist", "children", "support")

    def __init__(self, name=None, dist=0.0, children=None, support=None):
        self.name = name
        self.dist = dist if dist is not None else 0.0
        self.children = children or []
        self.support = support


def parse_newick(s: str) -> Node:
    s = s.strip()
    if s.endswith(";"):
        s = s[:-1]

    def parse_subtree(i: int):
        children = []
        if i < len(s) and s[i] == "(":
            i += 1
            while True:
                child, i = parse_subtree(i)
                children.append(child)
                if i < len(s) and s[i] == ",":
                    i += 1
                    continue
                if i < len(s) and s[i] == ")":
                    i += 1
                    break
                raise ValueError(f"bad newick at {i}")
        label = ""
        if i < len(s) and s[i] in {"'", '"'}:
            quote = s[i]
            i += 1
            parts = []
            while i < len(s):
                if s[i] == quote:
                    if quote == "'" and i + 1 < len(s) and s[i + 1] == quote:
                        parts.append(quote)
                        i += 2
                        continue
                    i += 1
                    break
                parts.append(s[i])
                i += 1
            else:
                raise ValueError("unterminated quoted Newick label")
            label = "".join(parts)
        else:
            j = i
            while j < len(s) and s[j] not in ":,();":
                j += 1
            label = s[i:j] if j > i else ""
            i = j
        dist = 0.0
        if i < len(s) and s[i] == ":":
            i += 1
            j = i
            while j < len(s) and s[j] in "0123456789.eE+-":
                j += 1
            dist = float(s[i:j]) if j > i else 0.0
            i = j
        name = None
        support = None
        if children:
            if label:
                try:
                    support = float(label)
                except ValueError:
                    name = label
        else:
            name = label if label else "unnamed"
        return Node(name=name, dist=dist, children=children, support=support), i

    root, _ = parse_subtree(0)
    return root


def _layout2(n: Node, y_cursor: list, leaf_gap: float, x_left: float):
    segments = []
    labels = []
    x_here = x_left + max(n.dist, 0.0)
    if not n.children:
        y = y_cursor[0]
        y_cursor[0] += leaf_gap
        segments.append((x_left, y, x_here, y))
        labels.append((x_here, y, n.name or "", True, None))
        return segments, labels, y
    child_mids = []
    for c in n.children:
        segs, labs, mid = _layout2(c, y_cursor, leaf_gap, x_here)
        segments.extend(segs)
        labels.extend(labs)
        child_mids.append(mid)
    y_top, y_bot = min(child_mids), max(child_mids)
    y_mid = (y_top + y_bot) / 2
    segments.append((x_here, y_top, x_here, y_bot))
    segments.append((x_left, y_mid, x_here, y_mid))
    if n.support is not None:
        labels.append(
            (x_here, y_mid, f"{n.support:.0f}" if n.support >= 1 else f"{n.support:.2f}", False, n.support)
        )
    return segments, labels, y_mid


def count_leaves(n: Node) -> int:
    if not n.children:
        return 1
    return sum(count_leaves(c) for c in n.children)


def tree_depth(n: Node) -> float:
    if not n.children:
        return max(n.dist, 0.0)
    return max(n.dist, 0.0) + max(tree_depth(c) for c in n.children)


def _newick_to_svg(nwk_path: Path, svg_path: Path, title: str, query_id: str = "") -> None:
    nwk = nwk_path.read_text(encoding="utf-8").strip()
    root = parse_newick(nwk)
    nleaves = count_leaves(root)
    depth = max(tree_depth(root), 1e-6)
    y_cursor = [0.0]
    leaf_gap = 1.0
    segs, labs, _ = _layout2(root, y_cursor, leaf_gap, 0.0)
    pad_l, pad_r, pad_t, pad_b = 40, 220, 40, 40
    plot_w, plot_h = 720, max(400, int(nleaves * 18))
    max_x = max((s[2] for s in segs), default=depth)
    max_x = max(max_x, depth, 1e-9)
    max_y = max(y_cursor[0] - leaf_gap, 1.0)

    def sx(x):
        return pad_l + (x / max_x) * plot_w

    def sy(y):
        return pad_t + (y / max_y) * plot_h

    W = pad_l + plot_w + pad_r
    H = pad_t + plot_h + pad_b
    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" font-family="Segoe UI, Arial, sans-serif">',
        '<rect width="100%" height="100%" fill="white"/>',
        f'<text x="{pad_l}" y="24" font-size="14" font-weight="bold">{_xml_esc(title)}</text>',
        f'<text x="{pad_l}" y="40" font-size="11" fill="#444">IQ-TREE2 ML + ModelFinder + UFBoot 1000</text>',
    ]
    for x1, y1, x2, y2 in segs:
        lines.append(
            f'<line x1="{sx(x1):.1f}" y1="{sy(y1):.1f}" x2="{sx(x2):.1f}" y2="{sy(y2):.1f}" '
            f'stroke="#222" stroke-width="1.2"/>'
        )
    for x, y, text, is_leaf, support in labs:
        if is_leaf:
            is_q = bool(query_id) and (text == query_id or "query" in (text or "").lower())
            fill = "#c0392b" if is_q else "#111"
            weight = "bold" if is_q else "normal"
            lines.append(
                f'<text x="{sx(x)+4:.1f}" y="{sy(y)+4:.1f}" font-size="11" fill="{fill}" font-weight="{weight}">{_xml_esc(text)}</text>'
            )
        else:
            if text and text != "0":
                lines.append(
                    f'<text x="{sx(x)-2:.1f}" y="{sy(y)-3:.1f}" font-size="8" fill="#1a5276" text-anchor="end">{_xml_esc(text)}</text>'
                )
    bar_len = max_x * 0.1
    bx, by = pad_l, H - 18
    lines.append(
        f'<line x1="{bx}" y1="{by}" x2="{bx + (bar_len/max_x)*plot_w:.1f}" y2="{by}" stroke="#000" stroke-width="2"/>'
    )
    lines.append(f'<text x="{bx}" y="{by-4}" font-size="10">0.1 subst/site (approx.)</text>')
    lines.append("</svg>")
    svg_path.write_text("\n".join(lines), encoding="utf-8")


def _xml_esc(s: str) -> str:
    return (
        (s or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _draw_tree_png(nwk_path: Path, out_path: Path, cfg: PipelineConfig) -> None:
    """Simple PNG via matplotlib if available."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    nwk = nwk_path.read_text(encoding="utf-8").strip()
    root = parse_newick(nwk)
    y_cursor = [0.0]
    segs, labs, _ = _layout2(root, y_cursor, 1.0, 0.0)
    max_x = max((s[2] for s in segs), default=1.0) or 1.0
    max_y = max(y_cursor[0] - 1.0, 1.0)
    nleaves = count_leaves(root)
    fig_h = max(6, nleaves * 0.28)
    fig, ax = plt.subplots(figsize=(12, fig_h), dpi=120)
    for x1, y1, x2, y2 in segs:
        ax.plot([x1, x2], [y1, y2], color="#333", linewidth=0.9)
    for x, y, text, is_leaf, _ in labs:
        if is_leaf:
            is_q = "query" in (text or "").lower() or (cfg.alias and cfg.alias in (text or ""))
            ax.text(
                x + max_x * 0.01,
                y,
                text,
                fontsize=7,
                va="center",
                color="#c0392b" if is_q else "#111",
                fontweight="bold" if is_q else "normal",
            )
    ax.set_ylim(max_y + 0.5, -0.5)
    ax.set_xlim(-max_x * 0.02, max_x * 1.35)
    ax.axis("off")
    ax.set_title(f"{cfg.display_name()} ML phylogeny (IQ-TREE2)")
    fig.tight_layout()
    fig.savefig(out_path)
    plt.close(fig)
