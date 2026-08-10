# -*- coding: utf-8 -*-
"""Strictly local MAFFT alignment and Logomaker sequence-logo generation."""
from __future__ import annotations

import shutil
import subprocess
import re
from pathlib import Path
from typing import Any, Optional

from ..config import PipelineConfig, STEP_DIRS, repo_root
from ..utils import ensure_dir, log, log_err, parse_fasta, write_json


def _relative(cfg: PipelineConfig, path: Path) -> str:
    return path.relative_to(cfg.resolve_out()).as_posix()


def _validate_multi_fasta(path: Path) -> list[dict]:
    if not path.is_file():
        raise ValueError("--alignment must point to an existing multi-FASTA file")
    records = parse_fasta(path)
    if len(records) < 2:
        raise ValueError(f"Multi-sequence analysis requires at least 2 records, got {len(records)}")
    if any(not record["seq"] for record in records):
        raise ValueError("Alignment input contains an empty sequence")
    return records


def _is_aligned(records: list[dict]) -> bool:
    return len({len(record["seq"]) for record in records}) == 1


def _find_mafft() -> str | None:
    """Find MAFFT on PATH or in the repo/bundled engine tools directory."""
    on_path = shutil.which("mafft") or shutil.which("mafft.bat")
    if on_path:
        return on_path
    tools_dir = repo_root() / "tools"
    if tools_dir.is_dir():
        candidates = sorted(tools_dir.rglob("mafft.bat"), key=lambda path: (len(path.parts), str(path).lower()))
        if candidates:
            return str(candidates[0])
    return None


def _windows_batch_command(arguments: list[str]) -> str:
    inner = subprocess.list2cmdline(arguments)
    cmd_exe = shutil.which("cmd.exe") or "cmd.exe"
    return f'{subprocess.list2cmdline([cmd_exe])} /d /s /c "{inner}"'


def _mafft_command(executable: str, source: Path) -> list[str] | str:
    arguments = [executable, "--auto", "--quiet", str(source)]
    if Path(executable).suffix.lower() == ".bat":
        # Windows cannot CreateProcess a batch file directly.  /d disables
        # AutoRun commands and /s preserves cmd.exe's documented /c quoting.
        # cmd.exe does not parse CreateProcessW quoting like a normal argv
        # consumer.  Pass a raw command line with the documented double outer
        # quote for /s /c, otherwise paths containing spaces retain literal
        # backslashes before their quotes.
        return _windows_batch_command(arguments)
    return arguments


def _detect_mafft_version(executable: str) -> str:
    path_match = re.search(r"(?i)mafft[^0-9]{0,12}(\d+\.\d+(?:\.\d+)?)", executable)
    if path_match:
        return path_match.group(1)
    arguments = [executable, "--version"]
    command: list[str] | str = (
        _windows_batch_command(arguments)
        if Path(executable).suffix.lower() == ".bat"
        else arguments
    )
    try:
        process = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
        )
        output = "\n".join((process.stdout, process.stderr))
        match = re.search(r"(?i)(?:mafft\s+)?v?(\d+\.\d+(?:\.\d+)?)", output)
        if match:
            return match.group(1)
    except Exception:
        pass
    return "runtime probe unavailable; see executable path"


def run_msa_weblogo(
    cfg: PipelineConfig,
    state: Any,
    *,
    source_fasta: Optional[Path] = None,
    run_mafft: bool = True,
    run_logo: bool = True,
) -> dict[str, Any]:
    """Run selected local tools without REST or approximate alignment fallbacks."""
    source = Path(source_fasta or cfg.alignment_fasta) if (source_fasta or cfg.alignment_fasta) else None
    if source is None:
        message = "Provide --alignment with at least two protein FASTA records"
        if run_mafft:
            state.set_step("mafft", "needs_setup", message=message)
        if run_logo:
            state.set_step("weblogo", "needs_setup", message=message)
        return {"error": message, "alignment_path": None}

    try:
        records = _validate_multi_fasta(source)
    except ValueError as exc:
        if run_mafft:
            state.set_step("mafft", "failed", message=str(exc))
        if run_logo:
            state.set_step("weblogo", "failed", message=str(exc))
        return {"error": str(exc), "alignment_path": None}

    out = ensure_dir(cfg.resolve_out() / STEP_DIRS["msa"])
    alignment_path: Path | None = None
    method: str | None = None

    if run_mafft:
        mafft_bin = _find_mafft()
        if not mafft_bin:
            state.set_step(
                "mafft",
                "needs_setup",
                message="Local MAFFT executable not found on PATH; online fallback is disabled",
            )
        else:
            state.set_step("mafft", "running", message="Running local MAFFT")
            alignment_path = out / "mafft.fasta"
            command = _mafft_command(mafft_bin, source)
            try:
                process = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=600,
                )
            except Exception as exc:
                state.set_step("mafft", "failed", message=f"Local MAFFT failed: {exc}")
                alignment_path = None
            else:
                (out / "mafft_stderr.txt").write_text(process.stderr, encoding="utf-8")
                if process.returncode != 0 or not process.stdout.lstrip().startswith(">"):
                    state.set_step(
                        "mafft",
                        "failed",
                        message=f"Local MAFFT exited with code {process.returncode}",
                        artifacts=[_relative(cfg, out / "mafft_stderr.txt")],
                    )
                    alignment_path = None
                else:
                    alignment_path.write_text(process.stdout, encoding="utf-8")
                    aligned_records = _validate_multi_fasta(alignment_path)
                    if not _is_aligned(aligned_records):
                        state.set_step("mafft", "failed", message="MAFFT output has inconsistent column counts")
                        alignment_path = None
                    else:
                        method = f"local MAFFT: {mafft_bin}"
                        result = {
                            "method": method,
                            "executable": mafft_bin,
                            "version": _detect_mafft_version(mafft_bin),
                            "nSequences": len(aligned_records),
                            "nColumns": len(aligned_records[0]["seq"]),
                            "alignment": _relative(cfg, alignment_path),
                        }
                        write_json(out / "mafft.json", result)
                        state.set_section("mafft", result)
                        state.set_step(
                            "mafft",
                            "completed",
                            message=f"{result['nSequences']} sequences × {result['nColumns']} columns",
                            artifacts=[_relative(cfg, out / "mafft.json"), result["alignment"]],
                        )
                        log("[mafft] local alignment completed")
    if alignment_path is None and _is_aligned(records):
        alignment_path = out / "provided_alignment.fasta"
        if source.resolve() != alignment_path.resolve():
            shutil.copyfile(source, alignment_path)
        method = "user-provided aligned FASTA"
    elif alignment_path is None and run_logo:
        state.set_step(
            "weblogo",
            "needs_setup",
            message="WebLogo needs equal-length aligned sequences; select MAFFT or provide an aligned FASTA",
        )

    logo_result: dict[str, Any] | None = None
    if run_logo and alignment_path is not None:
        logo_result = _run_weblogo(cfg, state, alignment_path, out, alignment_method=method or "alignment")

    return {
        "alignment_path": str(alignment_path) if alignment_path else None,
        "alignment_method": method,
        "weblogo": logo_result,
    }


def _run_weblogo(
    cfg: PipelineConfig,
    state: Any,
    alignment_path: Path,
    out: Path,
    *,
    alignment_method: str,
) -> dict[str, Any]:
    state.set_step("weblogo", "running", message="Rendering local sequence logo")
    png = out / "weblogo.png"
    try:
        import logomaker
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        records = _validate_multi_fasta(alignment_path)
        if not _is_aligned(records):
            raise ValueError("WebLogo input sequences have inconsistent column counts")
        sequences = [record["seq"].upper() for record in records]
        counts = logomaker.alignment_to_matrix(sequences, to_type="counts")
        information = logomaker.transform_matrix(counts, from_type="counts", to_type="information")
        figure, axis = plt.subplots(
            figsize=(max(8, min(24, information.shape[0] / 8)), 3),
            dpi=120,
        )
        logomaker.Logo(information, ax=axis, color_scheme="chemistry")
        axis.set_ylabel("Information (bits)")
        axis.set_title(f"{cfg.display_name()} local sequence logo")
        figure.tight_layout()
        figure.savefig(png)
        plt.close(figure)
        result = {
            "method": "local Logomaker information-content logo",
            "alignmentMethod": alignment_method,
            "nSequences": len(records),
            "nColumns": int(information.shape[0]),
            "figure": _relative(cfg, png),
        }
        write_json(out / "weblogo.json", result)
        state.set_section("weblogo", result)
        state.set_step(
            "weblogo",
            "completed",
            message="Local sequence logo generated",
            artifacts=[_relative(cfg, out / "weblogo.json"), result["figure"]],
        )
        return result
    except ImportError as exc:
        state.set_step("weblogo", "needs_setup", message=f"Logomaker dependency unavailable: {exc}")
        return {"error": str(exc)}
    except Exception as exc:
        log_err(f"[weblogo] {exc}")
        state.set_step("weblogo", "failed", message=str(exc))
        return {"error": str(exc)}
