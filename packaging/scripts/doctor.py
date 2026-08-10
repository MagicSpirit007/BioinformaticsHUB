# -*- coding: utf-8 -*-
"""BioinformaticsHUB website-session engine self-check.

Exit 0 when sequence preparation, local tools, and the bundled Playwright
browser are usable.  Network APIs are deliberately not part of this engine.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def find_engine_root() -> Path:
    here = Path(__file__).resolve().parent
    # packaging/engine/doctor.py
    if (here / "scripts" / "session_runner.py").is_file():
        return here
    # packaging/scripts/doctor.py → packaging/engine or repo root
    repo = here.parents[1]  # repository root
    staged = repo / "packaging" / "engine"
    if (staged / "scripts" / "session_runner.py").is_file():
        return staged
    if (repo / "scripts" / "session_runner.py").is_file():
        return repo
    return here


def main() -> int:
    root = find_engine_root()
    report: dict = {
        "ok": True,
        "python": sys.version,
        "executable": sys.executable,
        "engine_root": str(root),
        "checks": {},
    }

    def check(name: str, fn) -> None:
        try:
            fn()
            report["checks"][name] = {"ok": True}
        except Exception as e:
            report["checks"][name] = {"ok": False, "error": str(e)[:300]}
            report["ok"] = False

    def need_mod(mod: str) -> None:
        __import__(mod)

    check("biopython", lambda: need_mod("Bio"))
    check("matplotlib", lambda: need_mod("matplotlib"))
    check("numpy", lambda: need_mod("numpy"))
    check("logomaker", lambda: need_mod("logomaker"))
    check("PIL", lambda: need_mod("PIL"))

    def playwright_smoke() -> None:
        __import__("playwright")
        browser_root = root / "playwright-browsers"
        executables = sorted(browser_root.glob("chromium-*/chrome-win64/chrome.exe"))
        if not executables:
            raise FileNotFoundError(f"Bundled Chromium missing under: {browser_root}")
        report["checks"]["chromium"] = {
            "ok": True,
            "path": str(executables[-1]),
        }

    check("playwright", playwright_smoke)

    script = root / "scripts" / "session_runner.py"

    def need_file(p: Path) -> None:
        if not p.is_file():
            raise FileNotFoundError(str(p))

    check("session_runner", lambda: need_file(script))
    check(
        "local_tools_package",
        lambda: need_file(root / "scripts" / "pipeline" / "steps" / "input_prep.py"),
    )

    iq = root / "tools" / "iqtree-2.3.6-Windows" / "bin" / "iqtree2.exe"
    report["checks"]["iqtree"] = {
        "ok": iq.is_file(),
        "path": str(iq) if iq.is_file() else None,
        "optional": True,
    }

    mafft_required = True
    manifest_path = root / "engine_manifest.json"
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
            mafft_required = manifest.get("include_mafft", True) is not False
        except (OSError, ValueError, TypeError):
            pass

    mafft_candidates = sorted((root / "tools").glob("mafft-*/**/mafft.bat"))
    if mafft_candidates:
        report["checks"]["mafft"] = {
            "ok": True,
            "path": str(mafft_candidates[-1]),
        }
    else:
        report["checks"]["mafft"] = {
            "ok": not mafft_required,
            "error": f"Bundled MAFFT missing under: {root / 'tools'}",
            "optional": not mafft_required,
        }
        if mafft_required:
            report["ok"] = False

    def mpl_smoke() -> None:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        fig, ax = plt.subplots()
        ax.plot([0, 1], [0, 1])
        out = root / ".doctor_mpl.png"
        fig.savefig(str(out), dpi=72)
        plt.close(fig)
        if out.is_file():
            out.unlink(missing_ok=True)

    check("matplotlib_agg", mpl_smoke)

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
