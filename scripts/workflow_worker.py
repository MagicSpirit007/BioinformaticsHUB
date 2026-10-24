#!/usr/bin/env python3
"""One node per worker; request-correlated JSONL, with durable mutation ACKs."""
from __future__ import annotations

import json
import hashlib
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
ALLOWED_ENV = {"TYPESAFE_API_KEY", "TYPESAFE_MODEL", "TYPESAFE_BASE_URL", "TEXT_MODEL_API_KEY", "TEXT_MODEL_BASE_URL", "TEXT_MODEL", "TEXT_MODEL_REASONING", "BU_CDP_URL", "BU_CDP_WS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"}


def configure(settings):
    env_file = settings.get("envFile")
    if env_file:
        for raw in Path(env_file).read_text(encoding="utf-8-sig").splitlines():
            line = raw.strip()
            if line.startswith("export "):
                line = line[7:]
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key.strip() in ALLOWED_ENV:
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    if settings.get("chromeUrl"):
        os.environ["BU_CDP_URL"] = settings["chromeUrl"]
        os.environ.pop("BU_CDP_WS", None)
    endpoint = os.environ.get("BU_CDP_WS") or os.environ.get("BU_CDP_URL") or "unconfigured"
    os.environ["BU_NAME"] = "bioinformatics-hub-" + hashlib.sha256(endpoint.encode()).hexdigest()[:12]
    os.environ["BH_UPDATE_CHECK"] = "0"
    bypass = os.environ.get("NO_PROXY", os.environ.get("no_proxy", ""))
    os.environ["NO_PROXY"] = ",".join(filter(None, [bypass, "127.0.0.1", "localhost", "::1"]))


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    request = json.loads(sys.stdin.readline())
    request_id = request["requestId"]
    configure(request.get("settings", {}))
    control = {"pause": False, "cancel": False}

    def write(value):
        print(json.dumps({"requestId": request_id, **value}, ensure_ascii=False), flush=True)

    def emit(event):
        # Consume controls and ACKs synchronously at action boundaries. A second
        # thread blocked on Windows CRT stdin can deadlock native imports and
        # MSYS executables launched by local tools.
        event_id = uuid.uuid4().hex
        write({"type": "event", "eventId": event_id, "event": event})
        while True:
            line = sys.stdin.readline()
            if not line:
                control["cancel"] = True
                raise RuntimeError("Controller disconnected before action acknowledgement")
            message = json.loads(line)
            if message.get("requestId") != request_id:
                continue
            if message.get("type") == "control":
                action = message.get("action")
                if action in control:
                    control[action] = True
                continue
            if message.get("type") != "ack" or message.get("eventId") != event_id:
                continue
            if message.get("error"):
                raise RuntimeError("Controller refused action checkpoint")
            for key in control:
                control[key] = control[key] or bool(message.get("control", {}).get(key))
            return control

    try:
        if request.get("command") == "probe":
            import importlib.metadata
            status = {"pythonVersion": list(sys.version_info[:3]), "vendoredJev": str(Path(__file__).resolve().parent / "vendor" / "jev_ultrafast"), "keys": {key: bool(os.environ.get(key)) for key in ("TYPESAFE_API_KEY", "TEXT_MODEL_API_KEY")}, "packages": {}}
            for package in ("browser-harness", "httpx", "biopython", "numpy", "matplotlib", "logomaker", "Pillow"):
                try:
                    status["packages"][package] = importlib.metadata.version(package)
                except importlib.metadata.PackageNotFoundError:
                    status["packages"][package] = None
            status["textHelperConfigured"] = status["keys"]["TEXT_MODEL_API_KEY"]
            status["jevConfigured"] = status["keys"]["TYPESAFE_API_KEY"]
            status["ready"] = sys.version_info >= (3, 12) and status["jevConfigured"] and status["packages"]["browser-harness"] == "0.1.13" and bool(status["packages"]["httpx"])
            status["localReady"] = all(status["packages"].get(p) for p in ("biopython", "numpy", "matplotlib", "logomaker", "Pillow"))
            write({"type": "result", "result": status})
        elif request.get("command") == "browser_check":
            import urllib.request
            endpoint = os.environ.get("BU_CDP_URL", "")
            if not endpoint:
                raise ValueError("Set a Chrome debugging endpoint in Settings or BU_CDP_URL")
            try:
                with urllib.request.urlopen(endpoint.rstrip('/') + '/json/version', timeout=5) as response:
                    data = json.load(response)
                if not data.get('webSocketDebuggerUrl'):
                    raise ValueError('The endpoint is not a Chrome debugging server')
                write({"type": "result", "result": {"ok": True, "browser": data.get('Browser'), "message": "Chrome debugging connection is ready"}})
            except Exception:
                raise ValueError("Chrome debugging endpoint is unavailable. Start your dedicated Chrome profile with remote debugging, then test again.") from None
        elif request.get("command") == "model_check":
            from vendor.jev_ultrafast.model import post_json, policy_endpoint, validate_choice
            model = os.environ.get("TYPESAFE_MODEL", "jev-latest")
            url, headers = policy_endpoint(model)
            body = {"state": "Connection test: return OK.", "questions": {"connection": {"type": "choice", "criteria": {"OK": "The connection test is valid", "NO": "The test is invalid"}, "instructions": "Choose OK."}}}
            if not headers:
                body["model"] = model
            result = post_json(url, os.environ["TYPESAFE_API_KEY"], body, headers)
            validate_choice(result["answers"]["connection"], {"OK", "NO"})
            from vendor.jev_ultrafast.model import field_text
            text_helper = {"configured": bool(os.environ.get("TEXT_MODEL_API_KEY")), "ok": None}
            if text_helper["configured"]:
                try:
                    field_text({"goal": "Enter the word OK", "field": {"label": "Connection test"}, "page": {"title": "Test", "text": ""}, "recent_actions": []})
                    text_helper["ok"] = True
                except Exception:
                    text_helper["ok"] = False
            write({"type": "result", "result": {"ok": True, "jev": {"ok": True}, "textHelper": text_helper, "message": "Jev responded. Text helper is only needed for unbound ordinary text fields."}})
        elif request.get("command") == "resolve":
            from workflow.resolver import resolve_sequence
            write({"type": "result", "result": resolve_sequence(request["args"], request["cacheDir"])})
        elif request.get('command') == 'delivery_verify':
            from workflow.archive_validation import verify_pages
            write({'type': 'result', 'result': verify_pages(request['pages'])})
        elif request.get('command') == 'verify_downloads':
            from workflow.downloads import verify_files
            write({'type': 'result', 'result': verify_files(request['files'])})
        elif request.get('command') == 'analysis_verify':
            from workflow.analysis_verifiers import verify_analysis
            write({'type': 'result', 'result': verify_analysis(request)})
        elif request.get("command") == "archive":
            from workflow.browser import WorkflowBrowser
            from workflow.archive import archive_page
            from workflow.artifacts import scoped
            from browser_harness.admin import ensure_daemon
            from browser_harness.helpers import cdp
            ensure_daemon()
            checkpoint = request["checkpoint"]
            if not any(t["targetId"] == checkpoint.get("targetId") and t.get("browserContextId") == checkpoint.get("browserContextId") for t in cdp("Target.getTargets")["targetInfos"]):
                raise ValueError("Original result tab is unavailable; no analysis was resubmitted")
            root = Path(request["runDir"])
            browser = WorkflowBrowser(request["recipe"]["entryUrl"], checkpoint, request["recipe"]["allowedHosts"], root / "nodes" / request["nodeId"] / "archive-downloads")
            try:
                result = archive_page(browser, root, scoped(root, request["output"]), request["nodeId"], capture_only=request.get("captureOnly", False), scale=request.get("scale", 2), clip=request.get("clip"))
                write({"type": "result", "result": result})
            finally:
                browser.close()
        elif request.get("command") == "delivery_open":
            if not os.environ.get("BU_CDP_URL") and not os.environ.get("BU_CDP_WS"):
                raise ValueError("Configure the shared Chrome debugging connection before opening saved pages")
            from workflow.delivery import open_pages
            write({"type": "result", "result": open_pages(request["pages"], request.get("state"), prune=request.get("prune", False))})
        elif request.get("command") == "open_result":
            from urllib.parse import urlparse
            from browser_harness.admin import ensure_daemon
            from browser_harness.helpers import cdp
            url = urlparse(request["url"])
            if url.scheme not in {"https", "http"} or url.hostname not in request["allowedHosts"] or url.username or url.password:
                raise ValueError("Result URL is outside the configured service")
            ensure_daemon()
            context = cdp("Target.createBrowserContext", disposeOnDetach=False)["browserContextId"]
            target = cdp("Target.createTarget", url=request["url"], browserContextId=context)["targetId"]
            cdp("Target.activateTarget", targetId=target)
            write({"type": "result", "result": {"ok": True}})
        elif request.get("command") == "activate":
            from browser_harness.helpers import cdp
            target = request["targetId"]
            targets = cdp("Target.getTargets")["targetInfos"]
            if not any(t["targetId"] == target and t.get("browserContextId") == request["browserContextId"] for t in targets):
                raise ValueError("Owned browser tab is no longer available")
            cdp("Target.activateTarget", targetId=target)
            write({"type": "result", "result": {"ok": True}})
        else:
            payload = request["payload"]
            if payload["node"]["kind"] == "site":
                from workflow.site import run_site
                result = run_site(payload, emit, control)
            else:
                from workflow.local import run_local
                result = run_local(payload, emit)
            write({"type": "result", "result": result})
    except Exception as exc:
        # Never print request bodies, environment values or provider response bodies.
        message = str(exc)
        for key in ALLOWED_ENV:
            value = os.environ.get(key, "")
            if ("KEY" in key or "TOKEN" in key) and value:
                message = message.replace(value, "[redacted]")
        write({"type": "error", "message": f"{type(exc).__name__}: {message[:2000]}"})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
