from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
import sys

if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import session_runner  # noqa: E402
from pipeline.config import PipelineConfig  # noqa: E402
from pipeline.steps.input_prep import prepare_input  # noqa: E402
from pipeline.steps.iqtree_step import (  # noqa: E402
    _detect_alignment_sequence_type,
    _detect_iqtree_version,
    _restore_names,
    parse_newick,
    run_iqtree,
)
from pipeline.steps.itol_export import _leaf_labels, run_itol_export  # noqa: E402
from pipeline.steps.msa_weblogo import _detect_mafft_version, _mafft_command, run_msa_weblogo  # noqa: E402
from pipeline.steps.nucleic import _gc_by_codon_position  # noqa: E402


def write_fasta(path: Path, header: str, sequence: str) -> Path:
    path.write_text(f">{header}\n{sequence}\n", encoding="utf-8")
    return path


class TestInputPreparation(unittest.TestCase):
    def test_gc_by_codon_position_uses_triplet_stride(self) -> None:
        self.assertEqual(
            _gc_by_codon_position("GAAGAA"),
            {
                "gc1_percent": 100.0,
                "gc2_percent": 0.0,
                "gc3_percent": 0.0,
            },
        )

    def test_cds_translation_and_copy_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            fasta = write_fasta(base / "input.fa", "gene", "ATGAAATTTTAA")
            cfg = PipelineConfig(gene_id="GENE", alias="Alias", input_fasta=fasta, out_dir=base / "run")
            prepared = prepare_input(cfg)

            self.assertEqual(prepared["protein"], "MKF")
            payload = prepared["input"]
            self.assertEqual(payload["kind"], "cds")
            self.assertEqual(payload["length"], 12)
            self.assertEqual(payload["proteinLengthAa"], 3)
            self.assertEqual(payload["translation"]["terminalStopCodon"], "TAA")
            self.assertEqual(
                (base / "run" / payload["proteinFastaPath"]).read_text(encoding="utf-8"),
                ">GENE|protein\nMKF\n",
            )
            self.assertEqual(
                (base / "run" / payload["cdsFastaPath"]).read_text(encoding="utf-8"),
                ">GENE|CDS\nATGAAATTTTAA\n",
            )
            for forbidden in (
                "normalizedFasta",
                "nucleotideFasta",
                "cdsFasta",
                "proteinFasta",
                "alignmentFasta",
            ):
                self.assertNotIn(forbidden, payload)
            self.assertTrue((base / "run" / "00_input" / "input_meta.json").is_file())
            self.assertFalse((base / "run" / "session.json").exists())
            self.assertFalse((base / "run" / "results.json").exists())
            self.assertFalse((base / "run" / "status.json").exists())

    def test_incomplete_cds_warns_without_changing_frame(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            fasta = write_fasta(base / "input.fa", "gene", "ATGAAATAATTTG")
            cfg = PipelineConfig(
                gene_id="GENE",
                input_fasta=fasta,
                input_kind="cds",
                out_dir=base / "run",
            )
            prepared = prepare_input(cfg)
            warnings = " ".join(prepared["input"]["warnings"])
            self.assertIn("not divisible by 3", warnings)
            self.assertIn("internal stop codons", warnings)
            self.assertIsNone(prepared["protein"])
            self.assertFalse(prepared["input"]["hasProtein"])

    def test_protein_auto_detection_and_terminal_stop(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            fasta = write_fasta(base / "input.fa", "protein", "MPEPTIDEK*")
            cfg = PipelineConfig(gene_id="P", input_fasta=fasta, out_dir=base / "run")
            prepared = prepare_input(cfg)
            self.assertEqual(prepared["input"]["kind"], "protein")
            self.assertEqual(prepared["protein"], "MPEPTIDEK")
            self.assertIsNone(prepared["cds"])

    def test_alignment_is_copied_into_run_input(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            fasta = write_fasta(base / "input.fa", "protein", "MPEPTIDEK")
            alignment = base / "outside alignment.fa"
            alignment.write_text(">a\nMPEPTIDE-\n>b\nMPEPTIDEK\n", encoding="utf-8")
            run_dir = base / "run"
            cfg = PipelineConfig(
                gene_id="P",
                input_fasta=fasta,
                alignment_fasta=alignment,
                out_dir=run_dir,
            )
            prepared = prepare_input(cfg)
            payload = prepared["input"]
            self.assertEqual(payload["sourcePath"], "00_input/input.fasta")
            self.assertEqual(payload["alignmentFastaPath"], "00_input/alignment.fasta")
            self.assertEqual(
                (run_dir / payload["alignmentFastaPath"]).read_text(encoding="utf-8"),
                alignment.read_text(encoding="utf-8"),
            )


class TestLocalToolBoundaries(unittest.TestCase):
    def test_iqtree_alignment_type_detection_distinguishes_dna_and_protein(self) -> None:
        self.assertEqual(
            _detect_alignment_sequence_type([{"seq": "ACGTN-"}, {"seq": "ACGTA-"}]),
            "DNA",
        )
        self.assertEqual(
            _detect_alignment_sequence_type([{"seq": "MPEPTIDE"}, {"seq": "MPEPTVDE"}]),
            "AA",
        )
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            _detect_alignment_sequence_type([{"seq": "MKKM"}, {"seq": "MKKM"}])

    def test_iqtree_uses_detected_dna_type_and_reports_runtime_parameter(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            run_dir = base / "run"
            alignment = write_fasta(base / "dna.fa", "alpha", "ACGTACGT")
            with alignment.open("a", encoding="utf-8") as handle:
                handle.write(">beta\nACGTTCGT\n")
            executable = base / "iqtree2.exe"
            executable.write_bytes(b"")
            cfg = PipelineConfig(
                gene_id="G",
                out_dir=run_dir,
                iqtree_exe=executable,
            )
            events: list[dict] = []
            state = session_runner.EventState(emitter=events.append)
            commands: list[list[str]] = []

            def fake_run(command, **_kwargs):
                commands.append(command)
                prefix = Path(command[command.index("--prefix") + 1])
                Path(str(prefix) + ".treefile").write_text(
                    "(alpha:0.1,beta:0.2);\n",
                    encoding="utf-8",
                )
                return subprocess.CompletedProcess(command, 0, "", "")

            with (
                mock.patch("pipeline.steps.iqtree_step.subprocess.run", side_effect=fake_run),
                mock.patch("pipeline.steps.iqtree_step._detect_iqtree_version", return_value="test"),
            ):
                result = run_iqtree(cfg, state, alignment_path=alignment)

            self.assertEqual(commands[0][commands[0].index("-st") + 1], "DNA")
            self.assertEqual(result["sequenceType"], "DNA")
            self.assertEqual(events[-1]["parameters"]["sequenceType"], "DNA")

    def test_restored_newick_names_are_quoted(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            tree = base / "tree.treefile"
            mapping = base / "taxon_id_map.tsv"
            output = base / "tree.nwk"
            tree.write_text("(seq1:0.1,seq2:0.2);\n", encoding="utf-8")
            mapping.write_text(
                "short_id\toriginal_header\tungapped_len\n"
                "seq1\talpha:beta\t10\n"
                "seq2\tO'Brien\t10\n",
                encoding="utf-8",
            )
            _restore_names(tree, mapping, output, PipelineConfig(gene_id="G"))
            self.assertEqual(
                output.read_text(encoding="utf-8").strip(),
                "('alpha:beta':0.1,'O''Brien':0.2);",
            )
            restored = output.read_text(encoding="utf-8").strip()
            parsed = parse_newick(restored)
            self.assertEqual([child.name for child in parsed.children], ["alpha:beta", "O'Brien"])
            self.assertEqual(_leaf_labels(restored), ["alpha:beta", "O'Brien"])

    def test_mafft_missing_is_needs_setup_without_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            multi = base / "multi.fa"
            multi.write_text(">a\nMPEPTIDE\n>b\nMPEPTIDELONG\n", encoding="utf-8")
            cfg = PipelineConfig(gene_id="G", alignment_fasta=multi, out_dir=base / "run")
            events: list[dict] = []
            state = session_runner.EventState(emitter=events.append)
            with mock.patch("pipeline.steps.msa_weblogo._find_mafft", return_value=None):
                result = run_msa_weblogo(cfg, state, run_mafft=True, run_logo=False)
            self.assertIsNone(result["alignment_path"])
            self.assertEqual(state.steps["mafft"]["state"], "needs_setup")
            self.assertFalse((base / "run" / "07_msa" / "mafft.fasta").exists())

    def test_windows_batch_mafft_uses_cmd(self) -> None:
        with mock.patch("pipeline.steps.msa_weblogo.shutil.which", return_value=r"C:\Windows\System32\cmd.exe"):
            command = _mafft_command(r"D:\engine\tools\mafft\mafft.bat", Path(r"D:\input files\multi.fa"))
        self.assertIsInstance(command, str)
        self.assertTrue(str(command).startswith(r"C:\Windows\System32\cmd.exe /d /s /c"))
        self.assertIn("mafft.bat", str(command))
        self.assertIn("--auto", str(command))

    def test_executable_path_versions_are_auditable(self) -> None:
        self.assertEqual(_detect_mafft_version(r"D:\tools\mafft-7.526\mafft.bat"), "7.526")
        self.assertEqual(
            _detect_iqtree_version(Path(r"D:\tools\iqtree-2.3.6-Windows\bin\iqtree2.exe")),
            "2.3.6",
        )

    @unittest.skipUnless(os.name == "nt", "Windows batch invocation contract")
    def test_windows_batch_command_executes_with_spaced_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            batch = base / "fake mafft.bat"
            batch.write_text("@echo off\r\necho ^>query\r\necho MPEPTIDE\r\n", encoding="utf-8")
            source = write_fasta(base / "input sequences.fa", "q", "MPEPTIDE")
            command = _mafft_command(str(batch), source)
            process = subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        self.assertEqual(process.returncode, 0, f"command={command!r}\n{process.stderr}")
        self.assertIn(">query", process.stdout)

    def test_itol_bundle_is_local_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            run_dir = base / "run"
            tree = run_dir / "08_tree" / "tree.nwk"
            tree.parent.mkdir(parents=True)
            tree.write_text("(alpha:0.1,beta:0.2);\n", encoding="utf-8")
            cfg = PipelineConfig(gene_id="G", out_dir=run_dir)
            events: list[dict] = []
            state = session_runner.EventState(emitter=events.append)
            result = run_itol_export(cfg, state, tree_path=tree)
            self.assertEqual(result["leafCount"], 2)
            self.assertTrue((run_dir / result["bundle"]).is_file())
            completed = [event for event in events if event["id"] == "itol" and event["state"] == "completed"]
            self.assertEqual(len(completed), 1)
            self.assertTrue(all(isinstance(item, dict) for item in completed[0]["artifacts"]))

    def test_itol_without_tree_names_iqtree_dependency(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            cfg = PipelineConfig(gene_id="G", out_dir=Path(temp) / "run")
            events: list[dict] = []
            state = session_runner.EventState(emitter=events.append)
            result = run_itol_export(cfg, state)
            self.assertIn("error", result)
            self.assertEqual(events[-1]["state"], "needs_setup")
            self.assertIn("08_tree/tree.nwk from IQ-TREE", events[-1]["message"])
            self.assertEqual(events[-1]["parameters"]["requires"], "08_tree/tree.nwk from IQ-TREE")


class TestSessionRunnerProtocol(unittest.TestCase):
    def test_jsonl_only_and_electron_owns_session(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            fasta = write_fasta(base / "input.fa", "gene", "ATGAAATTTTAA")
            run_dir = base / "run"
            stdout = io.StringIO()
            stderr = io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                rc = session_runner.main(
                    [
                        "--fasta",
                        str(fasta),
                        "--id",
                        "GENE",
                        "--run-dir",
                        str(run_dir),
                        "--input-kind",
                        "cds",
                        "--local-tools",
                        "nucleic,physchem,hydrophobicity",
                        "--auto-sites",
                        "",
                    ]
                )
            self.assertEqual(rc, 0)
            lines = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
            self.assertEqual(lines[0]["type"], "input_ready")
            self.assertEqual(lines[-1], {"type": "done", "overall": "ok"})
            completed = [line for line in lines if line.get("type") == "local_update" and line.get("state") == "completed"]
            self.assertEqual({item["id"] for item in completed}, {"nucleic", "physchem", "hydrophobicity"})
            self.assertTrue(
                all(isinstance(artifact, dict) for item in completed for artifact in item["artifacts"])
            )
            for event in (line for line in lines if line.get("type") == "local_update"):
                self.assertIsInstance(event["parameters"], dict)
                self.assertIsInstance(event["source"], str)
                self.assertTrue(event["source"])
                self.assertIsInstance(event["version"], str)
                self.assertTrue(event["version"])
            self.assertTrue((run_dir / "01_nucleic" / "nucleic.json").is_file())
            self.assertTrue((run_dir / "02_physchem" / "physchem.json").is_file())
            self.assertTrue((run_dir / "03_hydrophobicity" / "hydrophobicity_kd.png").is_file())
            for forbidden in ("session.json", "results.json", "status.json", "report.json", "AI_分析包.md"):
                self.assertFalse((run_dir / forbidden).exists())

    def test_every_local_tool_update_has_top_level_audit_fields(self) -> None:
        events: list[dict] = []
        state = session_runner.EventState(emitter=events.append)
        for tool_id in session_runner.LOCAL_TOOL_ORDER:
            state.set_step(tool_id, "queued", message="Queued")
        self.assertEqual({event["id"] for event in events}, set(session_runner.LOCAL_TOOL_ORDER))
        for event in events:
            self.assertIsInstance(event["parameters"], dict)
            self.assertIsInstance(event["source"], str)
            self.assertTrue(event["source"])
            self.assertIsInstance(event["version"], str)
            self.assertTrue(event["version"])

        state.set_section(
            "mafft",
            {"executable": r"D:\engine\tools\mafft-7.526\mafft.bat", "version": "7.526", "method": "local MAFFT"},
        )
        state.set_step("mafft", "completed", message="done")
        self.assertEqual(events[-1]["source"], "00_input/alignment.fasta")
        self.assertEqual(events[-1]["version"], "7.526")
        self.assertEqual(events[-1]["provenance"]["executable"], r"D:\engine\tools\mafft-7.526\mafft.bat")

    def test_large_input_ready_is_metadata_only_and_bounded(self) -> None:
        max_event_line = 48 * 1024 * 1024
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            sequence = "MPEPTIDE" * 25_000
            fasta = write_fasta(base / "large.fa", "large_protein", sequence)
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
                rc = session_runner.main(
                    [
                        "--fasta",
                        str(fasta),
                        "--id",
                        "LARGE",
                        "--run-dir",
                        str(base / "run"),
                        "--input-kind",
                        "protein",
                    ]
                )
            raw_lines = [line for line in stdout.getvalue().splitlines() if line.strip()]
            input_line = next(line for line in raw_lines if json.loads(line).get("type") == "input_ready")
            event = json.loads(input_line)
            payload = event["input"]
            for forbidden in (
                "normalizedFasta",
                "nucleotideFasta",
                "cdsFasta",
                "proteinFasta",
                "alignmentFasta",
            ):
                self.assertNotIn(forbidden, payload)
            self.assertEqual(payload["proteinLengthAa"], len(sequence))
            self.assertEqual(payload["proteinFastaPath"], "00_input/protein.fasta")
            self.assertLess(len(input_line.encode("utf-8")), 16 * 1024)
            self.assertLess(len(input_line.encode("utf-8")), max_event_line // 1000)
            stored_meta = json.loads((base / "run" / "00_input" / "input_meta.json").read_text(encoding="utf-8"))
            self.assertFalse(any(key in stored_meta for key in forbidden))
            self.assertEqual(rc, 0)

    def test_unknown_site_is_process_input_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            fasta = write_fasta(base / "input.fa", "p", "MPEPTIDE")
            with contextlib.redirect_stderr(io.StringIO()):
                rc = session_runner.main(
                    [
                        "--fasta",
                        str(fasta),
                        "--id",
                        "P",
                        "--run-dir",
                        str(base / "run"),
                        "--auto-sites",
                        "deeptmhmm",
                    ]
                )
            self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main()
