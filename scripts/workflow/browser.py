"""Owned browser contexts and observations, using the vendored Jev executor."""
from __future__ import annotations

import base64
import json
import re
import time
from pathlib import Path
from urllib.parse import urlparse

from vendor.jev_ultrafast.browser import Browser, StalePage
from browser_harness.admin import ensure_daemon
from browser_harness.helpers import cdp


class HumanRequired(RuntimeError):
    pass


class WorkflowBrowser(Browser):
    def __init__(self, url: str, checkpoint: dict, allowed_hosts: list[str], downloads: Path):
        ensure_daemon()
        self.allowed_hosts = set(allowed_hosts)
        self.context_id = None
        self.frame_offset = (0, 0)
        self.after_input = None
        self.action_filter = None
        self.frames = []
        self.downloads = downloads
        downloads.mkdir(parents=True, exist_ok=True)
        targets = cdp("Target.getTargets")["targetInfos"]
        owned = next((t for t in targets if t["targetId"] == checkpoint.get("targetId")), None)
        self.restored_tab = bool(owned)
        if owned:
            self.target = owned["targetId"]
            self.browser_context = owned.get("browserContextId")
            if not self.browser_context or self.browser_context != checkpoint.get("browserContextId"):
                raise HumanRequired("Saved tab ownership could not be verified")
        else:
            if checkpoint.get("effectPending"):
                raise HumanRequired("Interrupted action and missing original tab: reconcile the remote job first")
            if checkpoint.get("submitted") and not checkpoint.get("resultUrl"):
                raise HumanRequired("Submitted job has no recoverable result URL; reconnect its original tab")
            if checkpoint.get('submitted'):
                receipt = urlparse(checkpoint['resultUrl'])
                if receipt.scheme not in {'http', 'https'} or receipt.hostname not in self.allowed_hosts or receipt.username or receipt.password or checkpoint['resultUrl'] == url:
                    raise HumanRequired('Stored receipt is not a recoverable result URL; reconcile the original job')
            self.browser_context = cdp("Target.createBrowserContext", disposeOnDetach=False)["browserContextId"]
            self.target = cdp("Target.createTarget", url="about:blank", browserContextId=self.browser_context, background=True)["targetId"]
        self.root_target = checkpoint.get("rootTargetId") or self.target
        self.session = cdp("Target.attachToTarget", targetId=self.target, flatten=True)["sessionId"]
        self.top_session = self.session
        cdp("Browser.setDownloadBehavior", behavior="allow", browserContextId=self.browser_context, downloadPath=str(downloads.resolve()), eventsEnabled=True)
        self.call("Emulation.setDeviceMetricsOverride", width=1280, height=900, deviceScaleFactor=1, mobile=False)
        self.call("Emulation.setFocusEmulationEnabled", enabled=True)
        if not owned:
            self.call("Page.navigate", url=checkpoint.get("resultUrl") or url)
            until = time.monotonic() + 15
            while time.monotonic() < until:
                try:
                    if self.evaluate("location.href !== 'about:blank' && document.readyState === 'complete'"):
                        break
                except Exception:
                    pass
                time.sleep(0.1)

        from .downloads import DownloadTracker
        try:
            tree = self.call("Page.getFrameTree")["frameTree"]
            def frame_ids(branch):
                return [branch["frame"]["id"], *[frame for child in branch.get("childFrames", []) for frame in frame_ids(child)]]
            self.download_tracker = DownloadTracker(frame_ids(tree), allowed_hosts, checkpoint.get("downloads"), self.browser_context, str(downloads.resolve()))
        except Exception:
            self.download_tracker = None

    def reconnect_owned(self):
        owned = next((t for t in cdp('Target.getTargets')['targetInfos'] if t['targetId'] == self.target and t.get('browserContextId') == self.browser_context), None)
        if not owned:
            raise HumanRequired('Browser disconnected from the original tab; reconcile its existing job before recovery')
        self.session = cdp('Target.attachToTarget', targetId=self.target, flatten=True)['sessionId']
        self.top_session = self.session
        self.context_id = None
        self.frame_offset = (0, 0)

    def call(self, method, **params):
        # Only reads can be repeated after a communication timeout. Mouse input,
        # navigation, uploads and submission always retain the uncertain checkpoint.
        read = method in {'Runtime.evaluate', 'Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.captureSnapshot', 'Page.captureScreenshot'}
        for attempt in range(2 if read else 1):
            try:
                return super().call(method, **params)
            except Exception as error:
                transient = 'timed out' in str(error).lower() or 'timeout' in type(error).__name__.lower()
                missing_session = 'Session with given id not found' in str(error)
                if not read or attempt or not (transient or missing_session):
                    raise
                self.reconnect_owned()
                params.pop('contextId', None)
                time.sleep(.2)

    def checkpoint(self):
        result = {"targetId": self.target, "rootTargetId": self.root_target, "browserContextId": self.browser_context}
        if getattr(self, "download_tracker", None):
            result["downloads"] = self.download_tracker.snapshot()
        return result

    def assert_url(self, url):
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or parsed.hostname not in self.allowed_hosts:
            raise HumanRequired("Browser reached an unconfigured domain or browser error page: " + parsed.netloc)

    def _follow_owned_popup(self):
        targets = cdp("Target.getTargets")["targetInfos"]
        children = [t for t in targets if t.get("browserContextId") == self.browser_context and t.get("openerId") == self.target and t.get("type") == "page" and (t.get("url", "").startswith(("https://", "http://")) or t.get("url") == 'about:blank')]
        if len(children) > 1:
            raise HumanRequired("Multiple task popups need a human selection")
        if children:
            child = children[0]
            if child['url'] != 'about:blank':
                self.assert_url(child["url"])
            self.target = child["targetId"]
            self.session = cdp("Target.attachToTarget", targetId=self.target, flatten=True)["sessionId"]
            self.top_session = self.session
            self.context_id = None
            self.frame_offset = (0, 0)

    def observe(self, screenshot=False):
        self._follow_owned_popup()
        deadline = time.monotonic() + 15
        while True:
            try:
                page = super().observe(screenshot=screenshot)
                break
            except Exception as error:
                stale = isinstance(error, StalePage)
                transient = 'timed out' in str(error).lower() or 'timeout' in type(error).__name__.lower() or 'Session with given id not found' in str(error)
                if not (stale or transient) or time.monotonic() >= deadline:
                    raise
                self.context_id = None
                self.session = self.top_session
                self.frame_offset = (0, 0)
                if transient:
                    self.reconnect_owned()
                    # One reconnect per observation, even when the daemon is unhealthy.
                    return super().observe(screenshot=screenshot)
                time.sleep(.15)
        # SPA shells can be document.complete while still having no usable UI.
        # Wait locally instead of spending model decisions on the loading screen.
        until = time.monotonic() + 10
        while len(page['text']) < 300 and re.search(r'loading|please wait', page['text'], re.I) and time.monotonic() < until:
            time.sleep(0.25)
            page = super().observe(screenshot=screenshot)
        if page['url'] == 'about:blank':
            page['url'] = self.result_url()
        self.assert_url(page["url"])
        self.frames = []
        try:
            tree = cdp("Page.getFrameTree", session_id=self.top_session)["frameTree"]
            def walk(branch):
                frame = branch["frame"]
                if getattr(self, "download_tracker", None):
                    self.download_tracker.frames.add(frame["id"])
                if frame.get("parentId") and urlparse(frame.get("url", "")).hostname in self.allowed_hosts:
                    self.frames.append(frame)
                for child in branch.get("childFrames", []):
                    walk(child)
            walk(tree)
        except Exception:
            pass
        if self.context_id:
            page["actions"].append({"id": "frame_top", "kind": "frame", "label": "Return to the top page", "frame": None})
        for index, frame in enumerate(self.frames[:12]):
            page["actions"].append({"id": f"frame_{index}", "kind": "frame", "label": f"Inspect embedded frame {frame.get('name') or frame.get('url')}", "frame": frame["id"]})
        # A native invalid form cannot submit. Offer Jev its editable controls,
        # scrolling and waiting, instead of repeatedly proposing a no-op submit.
        unavailable = []
        for action in page['actions']:
            if action.get('formSubmit'):
                invalid = self.invalid_form_fields(action)
                if invalid:
                    unavailable.append(action['id'])
        page['actions'] = [action for action in page['actions'] if action['id'] not in unavailable]
        if self.action_filter:
            page['actions'] = [action for action in page['actions'] if self.action_filter(action, page)]
        return page

    def act(self, action, page, text=None):
        if action["kind"] == "frame":
            if not self.fresh(page):
                raise StalePage("Page changed before switching frame")
            self.context_id = None
            self.frame_offset = (0, 0)
            self.session = self.top_session
            if action["frame"]:
                try:
                    result = self.call("Page.createIsolatedWorld", frameId=action["frame"], worldName="bioinformatics-hub")
                except RuntimeError:
                    # OOPIF target IDs are checked against the observed frame tree.
                    self.session = cdp("Target.attachToTarget", targetId=action["frame"], flatten=True)["sessionId"]
                    result = self.call("Page.createIsolatedWorld", frameId=action["frame"], worldName="bioinformatics-hub")
                self.context_id = result["executionContextId"]
                if self.session == self.top_session:
                    owner = cdp("DOM.getFrameOwner", session_id=self.top_session, frameId=action["frame"])
                    box = cdp("DOM.getBoxModel", session_id=self.top_session, backendNodeId=owner["backendNodeId"])["model"]["content"]
                    self.frame_offset = (box[0], box[1])
            return {"executed": action["id"]}
        return super().act(action, page, text=text)

    def field_value(self, action):
        node = action.get("node")
        if type(node) is not int:
            return None
        return self.evaluate(f"(() => {{ const cache=window.__jevFast, e=cache?.nodes.get({node}); return cache?.uploadReceipts?.[{node}] || (e?.type==='file' ? [...e.files].map(f=>({{name:f.name,size:f.size}})) : e?.value ?? e?.innerText ?? null); }})()")

    def invalid_form_fields(self, action):
        node = action.get('node')
        if type(node) is not int:
            return []
        return self.evaluate(f"(() => {{ const e=window.__jevFast?.nodes.get({node}); const form=e?.form || e?.closest('form'); return form ? [...form.elements].filter(f=>f.willValidate && !f.validity.valid).map(f=>({{label:f.getAttribute('aria-label')||[...(f.labels||[])].map(l=>l.innerText).join(' ')||f.name||f.type,type:f.type,required:f.required}})) : []; }})()")

    def document_evidence(self):
        for attempt in range(20):
            try:
                evidence = self._document_evidence()
                if evidence and evidence.get('url') == 'about:blank':
                    evidence['url'] = self.result_url()
                    evidence['generatedPopup'] = True
                if evidence and evidence.get('url') != 'about:blank':
                    return evidence
            except StalePage:
                pass
            time.sleep(0.1)
        raise StalePage('Document did not settle for result inspection')

    def result_url(self):
        value = self.evaluate("({url:location.href,base:document.baseURI,hasOpener:!!window.opener,text:document.body?.innerText?.length||0})")
        if value['url'] != 'about:blank':
            return value['url']
        # An official script-generated popup inherits its opener's base URL.
        # Only a nonempty owned child is eligible; ordinary blank tabs are not.
        target = next((t for t in cdp('Target.getTargets')['targetInfos'] if t['targetId'] == self.target), {})
        if target.get('browserContextId') != self.browser_context or not target.get('openerId') or not value['hasOpener'] or value['text'] < 30:
            raise HumanRequired('Blank page is not an identifiable generated result')
        self.assert_url(value['base'])
        return value['base']

    def _document_evidence(self):
        # Static, code-owned extraction; model text cannot become executable code.
        return self.evaluate("""(() => {
          const roots=[document];
          for(let i=0;i<roots.length;i++) for(const e of roots[i].querySelectorAll('*')) if(e.shadowRoot) roots.push(e.shadowRoot);
          return {url:location.href,title:document.title,
            text:roots.map(r=>(r.body||r).innerText||r.textContent||'').join('\\n').slice(0,500000),
            svgText:roots.flatMap(r=>[...r.querySelectorAll('svg text')].map(e=>e.textContent)).slice(0,10000),
            tree:location.hostname==='itol.embl.de' && typeof treeData==='object' && treeData?.leaf ? {
              name:treeData.info?.tree_name, leaves:treeData.leaf.map(id=>treeData.info?.names?.[id]||id),
              rendered:Boolean(document.querySelector('canvas#treeCanvas')?.width), nodeCount:Object.keys(treeData.node||{}).length
            }:null,
            links:roots.flatMap(r=>[...r.querySelectorAll('a[href]')].map(e=>({url:e.href,label:e.innerText||e.title,download:e.download}))).slice(0,1000),
            tables:roots.flatMap(r=>[...r.querySelectorAll('table')].map(t=>[...t.rows].slice(0,5000).map(r=>[...r.cells].map(c=>c.innerText)))).slice(0,50),
            fields:roots.flatMap(r=>[...r.querySelectorAll('input,select,textarea')].filter(e=>!['password','hidden','file'].includes(e.type)).map(e=>({label:e.getAttribute('aria-label')||[...(e.labels||[])].map(l=>l.innerText).join(' ')||e.name, value:e.tagName==='SELECT'?[...e.selectedOptions].map(o=>o.label).join(', '):e.value,type:e.type,checked:e.checked,active:!['radio','checkbox'].includes(e.type)||e.checked})))
          };
        })()""")

    def revisit_result(self, url):
        self.assert_url(url)
        self.context_id = None
        self.frame_offset = (0, 0)
        self.session = self.top_session
        self.call("Page.navigate", url=url)
        until = time.monotonic() + 15
        while time.monotonic() < until:
            try:
                if self.evaluate("document.readyState") == "complete":
                    return
            except RuntimeError:
                pass
            time.sleep(0.1)

    def download_observed_link(self, link: dict, output: Path):
        self.assert_url(link["url"])
        known = self.document_evidence()["links"]
        if not any(item["url"] == link["url"] for item in known):
            raise StalePage("Download link is no longer present")
        expression = """(async ({url,hosts}) => {
          const response=await fetch(url,{credentials:'include'});
          if(!response.ok || !hosts.includes(new URL(response.url).hostname)) throw new Error('Download failed or changed host');
          const blob=await response.blob(); if(blob.size>67108864 || !blob.size) throw new Error('Invalid download size');
          const bytes=new Uint8Array(await blob.arrayBuffer()); let value='';
          for(let i=0;i<bytes.length;i+=32768) value+=String.fromCharCode(...bytes.subarray(i,i+32768));
          return {data:btoa(value),url:response.url};
        })(""" + json.dumps({"url": link["url"], "hosts": sorted(self.allowed_hosts)}) + ")"
        result = self.call("Runtime.evaluate", expression=expression, awaitPromise=True, returnByValue=True)
        if result.get("exceptionDetails") or not result.get("result", {}).get("value"):
            raise ValueError("Browser could not download the observed link")
        value = result["result"]["value"]
        output.write_bytes(base64.b64decode(value["data"]))
        return value["url"]

    def screenshot(self, output: Path):
        output.write_bytes(base64.b64decode(self.call("Page.captureScreenshot", format="png")["data"]))

    def activate(self):
        cdp("Target.activateTarget", targetId=self.target)

    def close(self):
        if getattr(self, "download_tracker", None):
            self.download_tracker.close()
        # Owned contexts survive worker termination, remote waits and human handoff.
        # Browser context IDs are durable capabilities stored only in this run.
        try:
            cdp("Target.detachFromTarget", sessionId=self.session)
        except Exception:
            pass
