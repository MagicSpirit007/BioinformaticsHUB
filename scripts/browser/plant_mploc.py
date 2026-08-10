#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fail-closed Playwright adapter for the parameter-free Plant-mPLoc form."""
from __future__ import annotations

import webbrowser
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import urlsplit


SITE_ID = "plant_mploc"
ENTRY_URL = "http://www.csbio.sjtu.edu.cn/bioinf/plant-multi/"
RESULT_PATH = "/cgi-bin/PlantmPLoc.cgi"
FORM_SELECTOR = 'form[name="form1"][action="/cgi-bin/PlantmPLoc.cgi"][method="post"]'
SEQUENCE_SELECTOR = 'textarea[name="S1"]'
SUBMIT_SELECTOR = 'input[type="submit"][name="B1"][value="Submit"]'
PARAMETER_SELECTOR = 'select,input[type="radio"],input[type="checkbox"]'
RESULT_MARKERS = (
    "Plant-mPLoc Computation Result",
    "Predicted location(s)",
    "Your input sequence",
)
ENTRY_HOSTNAME = (urlsplit(ENTRY_URL).hostname or "").lower()


UpdateCallback = Callable[[dict[str, Any]], None]
OpenCallback = Callable[[str], Any]


_FORM_OWNERSHIP_SCRIPT = """
(element, formSelector) => element.form === document.querySelector(formSelector)
"""

_FORM_ELEMENT_PROFILE_SCRIPT = """
(form, parameterSelector) => {
    const elements = Array.from(form.elements || []);
    const normalizedName = (element) => String(element.name || "");
    const normalizedTag = (element) => String(element.tagName || "").toLowerCase();
    const normalizedType = (element) => String(element.type || "").toLowerCase();
    const isSubmit = (element) => {
        const tag = normalizedTag(element);
        const type = normalizedType(element);
        return (tag === "input" && (type === "submit" || type === "image")) ||
            (tag === "button" && type === "submit");
    };
    return {
        sequenceNameCount: elements.filter((element) => normalizedName(element) === "S1").length,
        submitNameCount: elements.filter((element) => normalizedName(element) === "B1").length,
        submitControlCount: elements.filter(isSubmit).length,
        parameterCount: elements.filter((element) => element.matches(parameterSelector)).length,
    };
}
"""


def _notify(callback: Optional[UpdateCallback], **payload: Any) -> None:
    if callback:
        callback({"id": SITE_ID, **payload})


def _open(open_url: OpenCallback, url: str) -> None:
    try:
        open_url(url)
    except Exception:
        # Opening is best-effort; the returned event still exposes the URL.
        pass


def is_expected_result_url(url: str) -> bool:
    """Accept only the official host and exact CGI path over normal HTTP(S)."""
    try:
        parsed = urlsplit(url)
        if parsed.scheme.lower() not in {"http", "https"}:
            return False
        if parsed.username is not None or parsed.password is not None:
            return False
        if (parsed.hostname or "").lower() != ENTRY_HOSTNAME:
            return False
        if parsed.path != RESULT_PATH:
            return False
        default_port = 443 if parsed.scheme.lower() == "https" else 80
        if parsed.port not in {None, default_port}:
            return False
        return True
    except (TypeError, ValueError):
        return False


def _needs_manual(
    message: str,
    *,
    open_url: OpenCallback,
    on_update: Optional[UpdateCallback],
) -> dict[str, Any]:
    _open(open_url, ENTRY_URL)
    result = {
        "id": SITE_ID,
        "state": "needs_manual",
        "message": message,
        "entryUrl": ENTRY_URL,
    }
    _notify(on_update, **{key: value for key, value in result.items() if key != "id"})
    return result


def submit_with_page(
    page: Any,
    fasta_text: str,
    *,
    timeout_ms: int = 180_000,
    open_url: OpenCallback = webbrowser.open,
    on_update: Optional[UpdateCallback] = None,
    artifact_dir: Optional[Path] = None,
) -> dict[str, Any]:
    """Submit through a Playwright-compatible page using only fixed selectors."""
    _notify(on_update, state="opening", message="Opening Plant-mPLoc", entryUrl=ENTRY_URL)
    try:
        page.set_default_timeout(timeout_ms)
        page.goto(ENTRY_URL, wait_until="domcontentloaded", timeout=timeout_ms)

        form = page.locator(FORM_SELECTOR)
        if form.count() != 1:
            return _needs_manual(
                "Plant-mPLoc form signature changed or is ambiguous",
                open_url=open_url,
                on_update=on_update,
            )
        # The official page contains legacy, non-conforming HTML: S1/B1 belong
        # to form1 through the DOM form-owner algorithm but are not descendants
        # returned by form.querySelectorAll().  Locate them globally, require a
        # unique exact signature, then verify their actual form owner.
        sequence = page.locator(SEQUENCE_SELECTOR)
        if sequence.count() != 1:
            return _needs_manual(
                "Plant-mPLoc sequence field changed or is ambiguous",
                open_url=open_url,
                on_update=on_update,
            )
        submit = page.locator(SUBMIT_SELECTOR)
        if submit.count() != 1:
            return _needs_manual(
                "Plant-mPLoc Submit button signature changed or is ambiguous",
                open_url=open_url,
                on_update=on_update,
            )
        if not sequence.evaluate(_FORM_OWNERSHIP_SCRIPT, FORM_SELECTOR):
            return _needs_manual(
                "Plant-mPLoc sequence field is not owned by the expected form",
                open_url=open_url,
                on_update=on_update,
            )
        if not submit.evaluate(_FORM_OWNERSHIP_SCRIPT, FORM_SELECTOR):
            return _needs_manual(
                "Plant-mPLoc Submit button is not owned by the expected form",
                open_url=open_url,
                on_update=on_update,
            )

        # Inspect the HTMLFormControlsCollection rather than descendants.  This
        # both supports the official legacy markup and fails closed if a same-
        # name control, another submit control, or a parameter control appears.
        profile = form.evaluate(_FORM_ELEMENT_PROFILE_SCRIPT, PARAMETER_SELECTOR)
        if not isinstance(profile, dict):
            return _needs_manual(
                "Plant-mPLoc form controls could not be verified",
                open_url=open_url,
                on_update=on_update,
            )
        if profile.get("sequenceNameCount") != 1:
            return _needs_manual(
                "Plant-mPLoc sequence field name is missing or ambiguous",
                open_url=open_url,
                on_update=on_update,
            )
        if profile.get("submitNameCount") != 1 or profile.get("submitControlCount") != 1:
            return _needs_manual(
                "Plant-mPLoc submit control changed or is ambiguous",
                open_url=open_url,
                on_update=on_update,
            )
        if profile.get("parameterCount") != 0:
            return _needs_manual(
                "Plant-mPLoc now exposes parameters; automatic choices are disabled",
                open_url=open_url,
                on_update=on_update,
            )

        sequence.fill(fasta_text)
        _notify(on_update, state="submitting", message="Submitting FASTA to Plant-mPLoc", entryUrl=ENTRY_URL)
        submit.click()
        try:
            page.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
        except Exception:
            # A completed CGI navigation is verified below by URL and body markers.
            pass

        result_url = str(page.url)
        body_text = page.locator("body").inner_text(timeout=timeout_ms)
        result_path_ok = is_expected_result_url(result_url)
        markers_ok = all(marker in body_text for marker in RESULT_MARKERS)
        if not result_path_ok or not markers_ok:
            return _needs_manual(
                "Plant-mPLoc result page could not be verified; no result was recorded",
                open_url=open_url,
                on_update=on_update,
            )

        artifacts: list[str] = []
        if artifact_dir is not None:
            artifact_dir.mkdir(parents=True, exist_ok=True)
            snapshot = artifact_dir / "result.html"
            snapshot.write_text(page.content(), encoding="utf-8")
            artifacts.append(str(snapshot))

        _open(open_url, result_url)
        result = {
            "id": SITE_ID,
            "state": "result_ready",
            "message": "Plant-mPLoc returned a verified result page",
            "entryUrl": ENTRY_URL,
            "resultUrl": result_url,
            "artifacts": artifacts,
        }
        _notify(
            on_update,
            state=result["state"],
            message=result["message"],
            entryUrl=ENTRY_URL,
            resultUrl=result_url,
        )
        return result
    except Exception as exc:
        return _needs_manual(
            f"Plant-mPLoc automation stopped safely: {exc}",
            open_url=open_url,
            on_update=on_update,
        )


def run_plant_mploc(
    protein: str,
    *,
    header: str,
    artifact_dir: Optional[Path] = None,
    timeout_ms: int = 180_000,
    open_url: OpenCallback = webbrowser.open,
    on_update: Optional[UpdateCallback] = None,
    playwright_factory: Optional[Callable[[], Any]] = None,
) -> dict[str, Any]:
    """Launch an isolated browser, submit FASTA, and open the verified result URL."""
    if not protein:
        return _needs_manual(
            "Plant-mPLoc requires a valid protein sequence",
            open_url=open_url,
            on_update=on_update,
        )
    if len(protein) < 50:
        return _needs_manual(
            "Plant-mPLoc requires a protein sequence of at least 50 amino acids",
            open_url=open_url,
            on_update=on_update,
        )
    fasta_text = f">{header}\n{protein}\n"
    if artifact_dir is not None:
        artifact_dir.mkdir(parents=True, exist_ok=True)
        (artifact_dir / "query.fasta").write_text(fasta_text, encoding="utf-8")

    try:
        if playwright_factory is None:
            from playwright.sync_api import sync_playwright

            playwright_factory = sync_playwright
    except ImportError:
        return _needs_manual(
            "Playwright is unavailable; Plant-mPLoc was opened for manual submission",
            open_url=open_url,
            on_update=on_update,
        )

    try:
        with playwright_factory() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page()
            try:
                return submit_with_page(
                    page,
                    fasta_text,
                    timeout_ms=timeout_ms,
                    open_url=open_url,
                    on_update=on_update,
                    artifact_dir=artifact_dir,
                )
            finally:
                browser.close()
    except Exception as exc:
        return _needs_manual(
            f"Plant-mPLoc browser could not start: {exc}",
            open_url=open_url,
            on_update=on_update,
        )
