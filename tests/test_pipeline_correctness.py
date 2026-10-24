from __future__ import annotations

import contextlib
import io
import json
import os
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
from browser.plant_mploc import (  # noqa: E402
    ENTRY_URL,
    FORM_SELECTOR,
    PARAMETER_SELECTOR,
    RESULT_MARKERS,
    SEQUENCE_SELECTOR,
    SUBMIT_SELECTOR,
    is_expected_result_url,
    run_plant_mploc,
    submit_with_page,
)


def configured_page(
    *,
    form_count: int = 1,
    sequence_count: int = 1,
    submit_count: int = 1,
    sequence_owned: bool = True,
    submit_owned: bool = True,
    sequence_name_count: int = 1,
    submit_name_count: int = 1,
    form_submit_count: int = 1,
    parameter_count: int = 0,
    body: str | None = None,
):
    page = mock.MagicMock()
    page.url = "http://www.csbio.sjtu.edu.cn/cgi-bin/PlantmPLoc.cgi"
    form = mock.MagicMock()
    form.count.return_value = form_count
    form.evaluate.return_value = {
        "sequenceNameCount": sequence_name_count,
        "submitNameCount": submit_name_count,
        "submitControlCount": form_submit_count,
        "parameterCount": parameter_count,
    }
    sequence = mock.MagicMock()
    sequence.count.return_value = sequence_count
    sequence.evaluate.return_value = sequence_owned
    submit = mock.MagicMock()
    submit.count.return_value = submit_count
    submit.evaluate.return_value = submit_owned
    body_locator = mock.MagicMock()
    body_locator.inner_text.return_value = body or "\n".join(RESULT_MARKERS)

    def page_locator(selector: str):
        if selector == FORM_SELECTOR:
            return form
        if selector == SEQUENCE_SELECTOR:
            return sequence
        if selector == SUBMIT_SELECTOR:
            return submit
        if selector == "body":
            return body_locator
        raise AssertionError(f"Unexpected page selector: {selector}")

    page.locator.side_effect = page_locator
    page.content.return_value = "<html><body>verified result</body></html>"
    return page, form, sequence, submit


class TestPlantMplocFixedAdapter(unittest.TestCase):
    def test_verified_result_uses_exact_form_and_opens_result(self) -> None:
        page, form, sequence, submit = configured_page()
        opened: list[str] = []
        updates: list[dict] = []
        with tempfile.TemporaryDirectory() as temp:
            result = submit_with_page(
                page,
                ">query\nMPEPTIDE\n",
                open_url=opened.append,
                on_update=updates.append,
                artifact_dir=Path(temp),
            )
            self.assertTrue((Path(temp) / "result.html").is_file())
        self.assertEqual(result["state"], "result_ready")
        self.assertEqual(opened, [page.url])
        page.locator.assert_any_call(FORM_SELECTOR)
        page.locator.assert_any_call(SEQUENCE_SELECTOR)
        page.locator.assert_any_call(SUBMIT_SELECTOR)
        form.locator.assert_not_called()
        sequence.evaluate.assert_called_once()
        submit.evaluate.assert_called_once()
        form.evaluate.assert_called_once()
        sequence.fill.assert_called_once_with(">query\nMPEPTIDE\n")
        submit.click.assert_called_once_with()
        self.assertEqual([item["state"] for item in updates], ["opening", "submitting", "result_ready"])

    def test_ambiguous_form_fails_closed_without_submit(self) -> None:
        page, _form, sequence, submit = configured_page(form_count=2)
        opened: list[str] = []
        result = submit_with_page(page, ">q\nMPEPTIDE\n", open_url=opened.append)
        self.assertEqual(result["state"], "needs_manual")
        self.assertEqual(opened, [ENTRY_URL])
        sequence.fill.assert_not_called()
        submit.click.assert_not_called()

    def test_new_parameter_control_fails_closed(self) -> None:
        page, _form, sequence, submit = configured_page(parameter_count=1)
        opened: list[str] = []
        result = submit_with_page(page, ">q\nMPEPTIDE\n", open_url=opened.append)
        self.assertEqual(result["state"], "needs_manual")
        self.assertIn("parameters", result["message"])
        self.assertEqual(opened, [ENTRY_URL])
        sequence.fill.assert_not_called()
        submit.click.assert_not_called()

    def test_wrong_form_owner_fails_closed(self) -> None:
        page, _form, sequence, submit = configured_page(sequence_owned=False)
        opened: list[str] = []
        result = submit_with_page(page, ">q\nMPEPTIDE\n", open_url=opened.append)
        self.assertEqual(result["state"], "needs_manual")
        self.assertIn("not owned", result["message"])
        self.assertEqual(opened, [ENTRY_URL])
        sequence.fill.assert_not_called()
        submit.click.assert_not_called()

    def test_extra_same_name_control_fails_closed(self) -> None:
        page, _form, sequence, submit = configured_page(sequence_name_count=2)
        opened: list[str] = []
        result = submit_with_page(page, ">q\nMPEPTIDE\n", open_url=opened.append)
        self.assertEqual(result["state"], "needs_manual")
        self.assertIn("ambiguous", result["message"])
        self.assertEqual(opened, [ENTRY_URL])
        sequence.fill.assert_not_called()
        submit.click.assert_not_called()

    def test_extra_submit_control_fails_closed(self) -> None:
        page, _form, sequence, submit = configured_page(form_submit_count=2)
        opened: list[str] = []
        result = submit_with_page(page, ">q\nMPEPTIDE\n", open_url=opened.append)
        self.assertEqual(result["state"], "needs_manual")
        self.assertIn("ambiguous", result["message"])
        self.assertEqual(opened, [ENTRY_URL])
        sequence.fill.assert_not_called()
        submit.click.assert_not_called()

    def test_missing_result_markers_never_invents_success(self) -> None:
        page, _form, sequence, submit = configured_page(body="Unexpected response")
        opened: list[str] = []
        result = submit_with_page(page, ">q\nMPEPTIDE\n", open_url=opened.append)
        self.assertEqual(result["state"], "needs_manual")
        self.assertNotIn("resultUrl", result)
        self.assertEqual(opened, [ENTRY_URL])
        sequence.fill.assert_called_once()
        submit.click.assert_called_once()

    def test_cross_domain_same_path_and_markers_fails_closed(self) -> None:
        page, _form, sequence, submit = configured_page()
        page.url = "https://evil.example/cgi-bin/PlantmPLoc.cgi"
        opened: list[str] = []
        result = submit_with_page(page, ">q\nMPEPTIDE\n", open_url=opened.append)
        self.assertEqual(result["state"], "needs_manual")
        self.assertNotIn("resultUrl", result)
        self.assertEqual(opened, [ENTRY_URL])
        sequence.fill.assert_called_once()
        submit.click.assert_called_once()

    def test_result_url_requires_exact_official_origin_shape(self) -> None:
        self.assertTrue(is_expected_result_url("http://www.csbio.sjtu.edu.cn/cgi-bin/PlantmPLoc.cgi"))
        self.assertTrue(is_expected_result_url("https://www.csbio.sjtu.edu.cn/cgi-bin/PlantmPLoc.cgi"))
        self.assertFalse(is_expected_result_url("javascript:alert(1)"))
        self.assertFalse(is_expected_result_url("https://evil.example/cgi-bin/PlantmPLoc.cgi"))
        self.assertFalse(is_expected_result_url("http://www.csbio.sjtu.edu.cn/redirect/cgi-bin/PlantmPLoc.cgi"))
        self.assertFalse(is_expected_result_url("http://www.csbio.sjtu.edu.cn:8080/cgi-bin/PlantmPLoc.cgi"))

    def test_browser_start_failure_opens_manual_entry(self) -> None:
        def broken_factory():
            raise RuntimeError("browser unavailable")

        opened: list[str] = []
        result = run_plant_mploc(
            "MPEPTIDE" * 7,
            header="query",
            open_url=opened.append,
            playwright_factory=broken_factory,
        )
        self.assertEqual(result["state"], "needs_manual")
        self.assertIn("browser could not start", result["message"])
        self.assertEqual(opened, [ENTRY_URL])

    def test_short_protein_fails_closed_before_browser(self) -> None:
        factory = mock.Mock(side_effect=AssertionError("browser must not start"))
        opened: list[str] = []
        result = run_plant_mploc(
            "MPEPTIDE",
            header="short_query",
            open_url=opened.append,
            playwright_factory=factory,
        )
        self.assertEqual(result["state"], "needs_manual")
        self.assertIn("at least 50 amino acids", result["message"])
        self.assertEqual(opened, [ENTRY_URL])
        factory.assert_not_called()

    @unittest.skipUnless(
        os.environ.get("BIOINFORMATICS_HUB_LIVE_PLANT_MPLOC") == "1",
        "live submission requires BIOINFORMATICS_HUB_LIVE_PLANT_MPLOC=1",
    )
    def test_live_submission_opt_in(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            artifact_dir = Path(temp)
            result = run_plant_mploc(
                "MSTNPKPQRKTKRNTNRRPQDVKFPGGGQIVGGVYLLPRRGPRLGVACDEFGHIKLMNPQ",
                header="bioinformatics-hub_live_test",
                artifact_dir=artifact_dir,
                open_url=lambda _url: None,
            )
            self.assertEqual(result["state"], "result_ready", result)
            self.assertTrue(is_expected_result_url(result["resultUrl"]))
            snapshot = (artifact_dir / "result.html").read_text(encoding="utf-8")
            for marker in RESULT_MARKERS:
                self.assertIn(marker, snapshot)


class TestRetiredRuntimeSurface(unittest.TestCase):
    def test_session_runner_leaves_browser_opening_to_electron(self) -> None:
        captured: list[dict] = []

        def fake_plant(_protein: str, **kwargs):
            captured.append(kwargs)
            self.assertIsNone(kwargs["open_url"](ENTRY_URL))
            kwargs["on_update"](
                {"id": "plant_mploc", "state": "result_ready", "entryUrl": ENTRY_URL, "resultUrl": ENTRY_URL}
            )
            return {"id": "plant_mploc", "state": "result_ready", "resultUrl": ENTRY_URL}

        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            fasta = base / "protein.fa"
            fasta.write_text(">p\nMPEPTIDE\n", encoding="utf-8")
            stdout = io.StringIO()
            with mock.patch("session_runner.run_plant_mploc", side_effect=fake_plant), contextlib.redirect_stdout(stdout):
                rc = session_runner.main(
                    [
                        "--fasta",
                        str(fasta),
                        "--id",
                        "P",
                        "--run-dir",
                        str(base / "run"),
                        "--input-kind",
                        "protein",
                        "--auto-sites",
                        "plant_mploc",
                    ]
                )
            events = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(rc, 0)
        self.assertEqual(len(captured), 1)
        self.assertTrue(any(event.get("type") == "site_update" for event in events))

    def test_cli_contract(self) -> None:
        parser = session_runner.build_parser()
        help_text = parser.format_help()
        for option in (
            "--fasta",
            "--id",
            "--run-dir",
            "--alias",
            "--input-kind",
            "--local-tools",
            "--auto-sites",
            "--alignment",
        ):
            self.assertIn(option, help_text)
        for removed in ("--proxy", "--with-llm-summary", "--skip-blast", "--with-hmmer"):
            self.assertNotIn(removed, help_text)

    def test_legacy_pipeline_remains_local_and_new_browser_workflow_uses_vendored_jev(self) -> None:
        python_files = list(SCRIPTS.rglob("*.py"))
        relative = {path.relative_to(SCRIPTS).as_posix() for path in python_files}
        self.assertNotIn("one_click_pipeline.py", relative)
        self.assertIn('vendor/jev_ultrafast/model.py', relative)
        self.assertIn('workflow/site.py', relative)
        workflow = (SCRIPTS / 'workflow/site.py').read_text(encoding='utf-8')
        self.assertIn('from vendor.jev_ultrafast import Agent', workflow)
        self.assertNotIn('playwright', workflow.lower())
        browser_sources = {path for path in relative if path.startswith("browser/")}
        self.assertEqual(browser_sources, {"browser/__init__.py", "browser/plant_mploc.py"})
        for path in python_files:
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("import requests", text, path.as_posix())
            self.assertNotIn("from requests", text, path.as_posix())
        requirements = (ROOT / "requirements-pipeline.txt").read_text(encoding="utf-8").lower()
        self.assertNotIn("requests", requirements)


if __name__ == "__main__":
    unittest.main()
