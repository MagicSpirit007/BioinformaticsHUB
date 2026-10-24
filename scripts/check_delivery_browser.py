"""Real headed Chrome: DOM fidelity, offline archives and one-window delivery.
Runs a local fixture only; never submits to an analysis website or calls a model.
"""
import argparse
import hashlib
import json
import os
import socket
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from urllib.parse import parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--chrome-url')
parser.add_argument('--launch', action='store_true')
args = parser.parse_args()
output = ROOT / 'runs' / ('delivery-smoke-' + str(int(time.time())))
output.mkdir(parents=True)
process = None
if args.launch:
    with socket.socket() as port:
        port.bind(('127.0.0.1', 0)); number = port.getsockname()[1]
    args.chrome_url = f'http://127.0.0.1:{number}'
    chrome = Path(os.environ.get('PROGRAMFILES', 'C:/Program Files')) / 'Google/Chrome/Application/chrome.exe'
    launch_args = [str(chrome), f'--remote-debugging-port={number}', f'--user-data-dir={output / "chrome-profile"}', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', 'about:blank']
    process = subprocess.Popen(launch_args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try:
            with urllib.request.urlopen(args.chrome_url + '/json/version', timeout=1) as response: json.load(response)
            break
        except Exception: time.sleep(.1)
if not args.chrome_url:
    parser.error('Use --chrome-url or --launch')
os.environ['BU_CDP_URL'] = args.chrome_url
os.environ['BU_NAME'] = 'biohub-delivery-smoke-' + str(os.getpid())
os.environ['BH_UPDATE_CHECK'] = '0'
os.environ['NO_PROXY'] = ','.join(filter(None, [os.environ.get('NO_PROXY', ''), '127.0.0.1', 'localhost']))
from workflow.browser import WorkflowBrowser
from workflow.archive import archive_page
from workflow.delivery import open_pages
from workflow.archive_validation import verify_pages
from browser_harness.helpers import cdp


class Handler(BaseHTTPRequestHandler):
    posts = 0
    def do_POST(self):
        Handler.posts += 1
        data = parse_qs(self.rfile.read(int(self.headers.get('Content-Length', 0))).decode())
        body = ('<html><body><h1>Original POST result</h1><textarea>' + data.get('sequence', [''])[0] + '</textarea><p>Original POST score 42</p></body></html>').encode()
        self.send_response(200); self.send_header('Content-Type', 'text/html'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path == '/post-entry':
            body, mime = b'<html><body><form action="/post-result" method="POST" target="analysis-result"><textarea name="sequence">MPEPTIDE</textarea><button>Submit fixture</button></form></body></html>', 'text/html'
        elif self.path == '/generated-entry':
            body, mime = b'''<html><body><button onclick="const w=window.open('', 'generated');w.document.write('<html><head><title>Generated result</title></head><body>Official generated result with complete sequence MPEPTIDE</body></html>');w.document.close()">Generate result</button></body></html>''', 'text/html'
        elif self.path in {'/blank-canvas','/webgl'}:
            code = 'const gl=plot.getContext("webgl");gl.clearColor(1,0,0,1);function draw(){gl.clear(gl.COLOR_BUFFER_BIT);requestAnimationFrame(draw)}draw()' if self.path == '/webgl' else 'plot.getContext("2d")'
            body, mime = ('<html><body><h1>Original chart result</h1><canvas id="plot" width="240" height="100"></canvas><script>'+code+'</script></body></html>').encode(), 'text/html'
        elif self.path == '/plot.svg':
            body, mime = b'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100"><rect width="240" height="100" fill="green"/><text x="10" y="50">Original SVG result</text></svg>', 'image/svg+xml'
        elif self.path == '/frame':
            body, mime = b'<html><body>Original iframe result 123<textarea id="value"></textarea><script>value.value="FRAME-SEQUENCE"</script></body></html>', 'text/html'
        elif self.path == '/font.ttf':
            font = Path('C:/Windows/Fonts/arial.ttf') if os.name == 'nt' else Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
            body, mime = font.read_bytes(), 'font/ttf'
        elif self.path == '/nested.css':
            body, mime = b'@font-face{font-family:ArchiveFixture;src:url("/font.ttf")} h1{font-family:ArchiveFixture}', 'text/css'
        elif self.path == '/style.css':
            body, mime = b'@import url("/nested.css");body{font:18px sans-serif;background:#fafaf7}textarea{width:400px;height:100px}.long{height:2500px}', 'text/css'
        else:
            loading = 'Loading' if self.path == '/stuck' else 'Loading'
            delay = '' if self.path == '/stuck' else 'setTimeout(()=>document.getElementById("progress").remove(),800);'
            body = ('''<!doctype html><html><head><title>Original fixture result</title><link rel="stylesheet" href="/style.css"></head><body><h1>Original result 42</h1><form action="/resubmit" method="POST"><textarea id="sequence"></textarea><select id="mode"><option>A</option><option>B</option></select><input id="checked" type="checkbox"><button>Submit</button></form><p id="progress">''' + loading + '''</p><img src="/plot.svg"><canvas id="plot" width="240" height="80"></canvas><iframe src="/frame"></iframe><div class="long">Long result</div><script>sequence.value=">fixture\\nMPEPTIDE\\n";mode.selectedIndex=1;checked.checked=true;let ctx=plot.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,240,80);''' + delay + '''</script></body></html>''').encode()
            mime = 'text/html'
        self.send_response(200); self.send_header('Content-Type', mime); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *_): pass


def evaluate(target, expression):
    session = cdp('Target.attachToTarget', targetId=target, flatten=True)['sessionId']
    try:
        result = cdp('Runtime.evaluate', session_id=session, expression=expression, returnByValue=True)
        if result.get('exceptionDetails'): raise ValueError(str(result['exceptionDetails']))
        return result.get('result', {}).get('value')
    finally: cdp('Target.detachFromTarget', sessionId=session)


def main():
    global process
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    browser = None; post_browser = None; delivery = None; checks = []
    try:
        browser = WorkflowBrowser(f'http://127.0.0.1:{server.server_port}/result', {}, ['127.0.0.1'], output / 'downloads')
        saved = archive_page(browser, output, output / 'webpage', 'fixture')
        assert saved['archive']['status'] == 'complete', saved['archive']
        file = output / 'webpage/page.html'; text = file.read_text(encoding='utf-8')
        assert 'MPEPTIDE' in text and '<script' not in text and 'data:image/png' in text
        assert 'Loading' not in text
        assert evaluate(browser.target, 'sequence.value') == '>fixture\nMPEPTIDE\n'
        checks.append('Rendered inputs, selections and canvas saved without changing live form')
        assert saved['archive']['visual']['status'] == 'complete'
        assert saved['archive']['embeddedFonts'] >= 1, 'Chrome-omitted fonts must be recovered and embedded'
        moved = output / '中文 导出副本'
        shutil.copytree(output / 'webpage', moved)
        checked = verify_pages([{'path': str(moved / 'page.html'), 'baseline': saved['archive']['baseline']}])
        assert checked['status'] == 'complete', checked
        checks.append('Nested CSS and actual font bytes render offline after moving into a Chinese/space directory')
        for css in (moved / 'assets').glob('*.css'):
            css.unlink()
        broken = verify_pages([{'path': str(moved / 'page.html'), 'baseline': saved['archive']['baseline']}])
        assert broken['status'] == 'partial' and broken['pages'][0]['issues'], broken
        checks.append('Missing stylesheets are rejected even though the HTML finishes loading')
        pages = [{'itemId': 'fixture', 'key': 'fixture', 'path': str(file), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}]
        extra = output / 'extra.html'; extra.write_text('<html><body>Second saved original result</body></html>')
        pages.append({'itemId': 'second', 'key': 'second', 'path': str(extra), 'sha256': hashlib.sha256(extra.read_bytes()).hexdigest()})
        post_browser = WorkflowBrowser(f'http://127.0.0.1:{server.server_port}/post-entry', {}, ['127.0.0.1'], output / 'post-downloads')
        parent_target = post_browser.target
        post_page = post_browser.observe()
        submit = next(a for a in post_page['actions'] if a['kind'] == 'click' and 'Submit fixture' in a['label'])
        post_browser.act(submit, post_page)
        deadline = time.monotonic() + 10
        while post_browser.target == parent_target:
            post_browser.observe()
            if time.monotonic() >= deadline: raise TimeoutError('Fixture result popup did not appear')
            time.sleep(.1)
        assert 'Original POST result' in post_browser.document_evidence()['text']
        archive_page(post_browser, output, output / 'post-webpage', 'post-fixture')
        post_file = output / 'post-webpage/page.html'
        pages.append({'itemId': 'post', 'key': 'post', 'path': str(post_file), 'sha256': hashlib.sha256(post_file.read_bytes()).hexdigest()})
        checks.append('A real POST response popup is followed, retained and archived without repeating submission')
        for route in ['blank-canvas','webgl','generated-entry']:
            case = WorkflowBrowser(f'http://127.0.0.1:{server.server_port}/{route}', {}, ['127.0.0.1'], output / (route+'-downloads'))
            try:
                if route == 'generated-entry':
                    p=case.observe();case.act(next(a for a in p['actions'] if a['label']=='Generate result'),p);case.observe()
                    assert case.target != case.root_target and 'Official generated result with complete sequence MPEPTIDE' in case.document_evidence()['text']
                saved_case=archive_page(case,output,output/route,route)
                assert saved_case['archive']['status']==('partial' if route=='blank-canvas' else 'complete'),saved_case['archive']
                if route=='webgl':
                    assert saved_case['archive']['staticRegions']==1
                    # A chart's raster clip must not replace the full-page capture.
                    shots=saved_case['archive']['images']
                    assert shots[0]['clip']['x']==0 and shots[0]['clip']['y']==0,shots
                    content=case.call('Page.getLayoutMetrics')['cssContentSize']
                    assert sum(s['clip']['height'] for s in shots)>=content['height']-1,shots
            finally:
                context=case.browser_context;case.close();cdp('Target.disposeBrowserContext',browserContextId=context)
        checks.append('Blank canvas is rejected; WebGL is frozen from its visible region; script-generated result popup archives safely')
        delivery = open_pages(pages)
        assert delivery['opened'] == len(pages) and not delivery['failed'], delivery
        assert len({p['windowId'] for p in delivery['pages']}) == 1
        target = delivery['pages'][0]['targetId']
        assert evaluate(target, 'document.querySelector("textarea").value') == '>fixture\nMPEPTIDE\n'
        assert evaluate(target, 'document.querySelector("select").value') == 'B'
        assert evaluate(target, 'document.querySelector("input").checked') is True
        assert evaluate(target, '[...document.images].every(i=>i.complete&&i.naturalWidth>0)')
        checks.append('Offline HTML, SVG, canvas image, iframe and actual form values render in one visible window')
        again = open_pages(pages, delivery['state'])
        assert [p['targetId'] for p in again['pages']] == [p['targetId'] for p in delivery['pages']]
        cdp('Target.closeTarget', targetId=again['pages'][1]['targetId'])
        recovered = open_pages(pages, again['state'])
        assert recovered['opened'] == len(pages) and recovered['pages'][0]['targetId'] == target
        checks.append('Repeated open reuses tabs; closing one tab recreates only that tab')
        cdp('Target.disposeBrowserContext', browserContextId=recovered['state']['browserContextId'])
        delivery = open_pages(pages, recovered['state'])
        assert delivery['opened'] == len(pages) and not delivery['failed']
        checks.append('A lost browser context restores all pages in a single new window')
        browser.revisit_result(f'http://127.0.0.1:{server.server_port}/stuck')
        incomplete = archive_page(browser, output, output / 'stuck', 'stuck')
        assert incomplete['archive']['status'] == 'partial'
        assert incomplete['archive']['visual']['status'] == 'partial'
        assert Handler.posts == 1
        checks.append('Loading graphs remain partial; opening archives never resubmits POST forms')
        if args.launch:
            saved_state = delivery['state']
            cdp('Browser.close')
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: process.terminate(); process.wait(timeout=5)
            process = subprocess.Popen(launch_args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(100):
                try:
                    with urllib.request.urlopen(args.chrome_url + '/json/version', timeout=1) as response: json.load(response)
                    break
                except Exception: time.sleep(.1)
            delivery = open_pages(pages, saved_state)
            assert delivery['opened'] == len(pages) and not delivery['failed'], delivery
            assert len({p['windowId'] for p in delivery['pages']}) == 1
            checks.append('Actual Chrome restart restores all saved pages together without analysis resubmission')
        result = {'ok': True, 'checks': checks, 'output': str(output), 'chromeUrl': args.chrome_url}
        (output / 'validation.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result))
    except Exception as error:
        result = {'ok': False, 'checks': checks, 'error': repr(error), 'output': str(output)}
        (output / 'validation.json').write_text(json.dumps(result, indent=2)); print(json.dumps(result)); raise
    finally:
        if post_browser:
            context = post_browser.browser_context; post_browser.close()
            try: cdp('Target.disposeBrowserContext', browserContextId=context)
            except Exception: pass
        if browser:
            context = browser.browser_context; browser.close()
            try: cdp('Target.disposeBrowserContext', browserContextId=context)
            except Exception: pass
        if delivery and delivery.get('state', {}).get('browserContextId'):
            try: cdp('Target.disposeBrowserContext', browserContextId=delivery['state']['browserContextId'])
            except Exception: pass
        server.shutdown()
        if process:
            try: cdp('Browser.close')
            except Exception: process.terminate()


if __name__ == '__main__': main()
