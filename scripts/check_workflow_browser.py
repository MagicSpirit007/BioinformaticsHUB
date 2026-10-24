"""Opt-in real Chrome regression, using Jev's observed-node executor (no paid models)."""
from __future__ import annotations

import json
import sys
import threading
import faulthandler
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from workflow_worker import configure

PAGE = b'''<!doctype html><html><body>
<label>Protein sequence<textarea id="seq" rows="4" cols="70"></textarea></label>
<label>Upload FASTA<input id="file" type="file"></label>
<input id="resetfile" type="file" aria-label="Resetting hidden upload" style="display:none" onchange="this.value=''">
<label>Model<select id="model"><option>Basic</option><option>Accurate</option></select></label>
<form><label><input type="checkbox" required>Notification consent</label><button id="submit" type="submit">Submit fixture</button></form>
<div id="shadow"></div><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<label>Shadow value<input type="text"></label>';</script>
<iframe src="/frame" title="Embedded analysis"></iframe>
<a href="/result.fasta" download="result.fasta">Download alignment</a>
<div style="height:80px;overflow-y:auto" aria-label="Options panel"><div style="height:600px">Scrollable content</div></div>
<div id="framework" style="cursor:pointer">Framework menu</div>
<script>document.querySelector('#framework').addEventListener('click',()=>document.body.dataset.framework='clicked');</script>
<a href="/popup" target="_blank">Open task popup</a>
</body></html>'''


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == '/frame':
            body = b'<html><body><label>Frame value<input type="text"></label></body></html>'
        elif self.path == '/result.fasta':
            body = b'>one\nMKKLL\n>two\nMKKAL\n'
        elif self.path == '/popup':
            body = b'<h1>Owned task result popup</h1>'
        else:
            body = PAGE
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream' if self.path.endswith('.fasta') else 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    faulthandler.dump_traceback_later(45, repeat=True)
    parser = argparse.ArgumentParser()
    parser.add_argument('--chrome-url', default='')
    args = parser.parse_args()
    configure({'envFile': str(Path.home() / 'jev-ultrafast' / '.env'), 'chromeUrl':args.chrome_url})
    from workflow.browser import WorkflowBrowser
    root = Path(__file__).resolve().parents[1] / 'runs' / 'browser-fixture'
    root.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    browser = WorkflowBrowser(f'http://127.0.0.1:{server.server_port}', {}, ['127.0.0.1'], root / 'downloads')
    evidence = []

    def act(kind, label, value=None):
        print(json.dumps({'checking': kind, 'label': label}), flush=True)
        page = browser.observe(False)
        actions = [a for a in page['actions'] if a['kind'] == kind and label.casefold() in a['label'].casefold()]
        if len(actions) != 1:
            raise AssertionError(f'Expected one {kind} {label}, observed {[(a["kind"], a["label"]) for a in page["actions"]]}')
        action = actions[0]
        browser.act(action, page, text=value)
        return action

    try:
        sequence = '>long\n' + 'ACDEFGHIKLMNPQRSTVWY' * 300 + '\n'
        action = act('fill', 'Protein sequence', sequence)
        assert browser.field_value(action) == sequence
        evidence.append('6000-residue exact input, no text generation')
        file = root / 'input.fasta'; file.write_bytes(sequence.encode('utf-8'))
        action = act('upload', 'Upload FASTA', str(file))
        assert browser.field_value(action)[0]['size'] == len(sequence.encode())
        evidence.append('observed file input upload')
        action = act('upload', 'Resetting hidden upload', str(file))
        assert browser.field_value(action)[0]['size'] == len(sequence.encode())
        evidence.append('hidden upload receipt survives the website clearing its input')
        act('select', 'Accurate')
        assert browser.evaluate('document.querySelector("#model").value') == 'Accurate'
        evidence.append('native dropdown')
        page = browser.observe(False)
        assert not any(a['label']=='Submit fixture' for a in page['actions'])
        act('click', 'Notification consent')
        submit = next(a for a in browser.observe(False)['actions'] if a['label']=='Submit fixture')
        assert not browser.invalid_form_fields(submit)
        evidence.append('native required consent is checked before recording submission intent')
        action = act('fill', 'Shadow value', 'shadow-ok')
        assert browser.field_value(action) == 'shadow-ok'
        evidence.append('open shadow root input')
        act('frame', 'embedded frame')
        action = act('fill', 'Frame value', 'frame-ok')
        assert browser.field_value(action) == 'frame-ok'
        act('frame', 'top page')
        evidence.append('embedded frame and return to main document')
        page = browser.document_evidence()
        link = next(link for link in page['links'] if '/result.fasta' in link['url'])
        result = root / 'downloaded.fasta'
        browser.download_observed_link(link, result)
        assert result.read_bytes().startswith(b'>one')
        evidence.append('download of observed official link')
        act('click', 'Download alignment')
        import time
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not any(row['state'] == 'completed' for row in browser.download_tracker.snapshot()):
            time.sleep(.1)
        assert any(row['state'] == 'completed' and row.get('name') == 'result.fasta' for row in browser.download_tracker.snapshot())
        evidence.append('native Chrome download is correlated by GUID, source URL and completion event')
        act('scroll', 'Options panel down')
        evidence.append('nested scrolling')
        browser.evaluate("document.querySelector('[aria-label=\"Options panel\"]').removeAttribute('aria-label');document.querySelector('[style*=\"overflow-y\"] div').textContent='X'.repeat(750000)")
        assert max(len(action['label']) for action in browser.observe(False)['actions'] if action['kind']=='scroll') < 200
        evidence.append('large scrollable content cannot overflow model context')
        act('click', 'Framework menu')
        assert browser.evaluate('document.body.dataset.framework') == 'clicked'
        evidence.append('framework pointer control without native button semantics')
        original = browser.target
        act('click', 'Open task popup')
        page = browser.observe(False)
        assert browser.target != original and 'Owned task result popup' in page['text']
        evidence.append('task popup remains in the owned browser context')
        print(json.dumps({'ok': True, 'checks': evidence}, ensure_ascii=False))
        (root / 'validation.json').write_text(json.dumps({'ok': True, 'checks': evidence}, indent=2), encoding='utf-8')
    finally:
        from browser_harness.helpers import cdp
        cdp('Target.disposeBrowserContext', browserContextId=browser.browser_context)
        browser.close()
        server.shutdown()


if __name__ == '__main__':
    main()
