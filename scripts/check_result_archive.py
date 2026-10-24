"""Real Chrome archive/offline/crop fixture. Does not call a model or analysis service."""
import argparse
import base64
import json
import os
import sys
import threading
import time
sys.dont_write_bytecode = True
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'runs' / ('archive-smoke-' + str(int(time.time())))
parser = argparse.ArgumentParser()
parser.add_argument('--chrome-url', default=os.environ.get('BU_CDP_URL', 'http://127.0.0.1:9222'))
parser.add_argument('--engine-root', type=Path, default=ROOT, help='Validate the actual packaged engine, or source by default')
options = parser.parse_args()
sys.path.insert(0, str(options.engine_root.resolve() / 'scripts'))
os.environ['BU_CDP_URL'] = options.chrome_url
os.environ.pop('BU_CDP_WS', None)
os.environ['BU_NAME'] = 'bioinformatics-hub-archive-check-' + str(os.getpid())
os.environ['BH_UPDATE_CHECK'] = '0'
os.environ['NO_PROXY'] = ','.join(filter(None, [os.environ.get('NO_PROXY', ''), '127.0.0.1', 'localhost', '::1']))

from workflow.archive import archive_page
from workflow.browser import WorkflowBrowser
from browser_harness.helpers import cdp



class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/style.css':
            body, mime = b'body{font:16px sans-serif;background:#fafafa} .long{height:5000px} table{border:1px solid black}', 'text/css'
        elif self.path == '/plot.svg':
            body, mime = b'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="#287a69"/><text x="20" y="80" fill="white">Official fixture plot</text></svg>', 'image/svg+xml'
        elif self.path == '/frame':
            body, mime = b'<html><body>Original frame result</body></html>', 'text/html'
        else:
            body, mime = b'''<!doctype html><html><head><title>Original service fixture</title><link rel="stylesheet" href="/style.css"></head><body><h1>Official result: fixture-123</h1><table><tr><td>Score</td><td>42</td></tr></table><img src="/plot.svg"><iframe src="/frame"></iframe><canvas width="100" height="100" id="canvas"></canvas><script>let c=document.getElementById('canvas').getContext('2d');c.fillStyle='red';c.fillRect(0,0,100,100)</script><div class="long">Long original page</div></body></html>''', 'text/html'
        self.send_response(200); self.send_header('Content-Type', mime); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *_): pass


def evaluate(session, expression):
    return cdp('Runtime.evaluate', session_id=session, expression=expression, returnByValue=True).get('result', {}).get('value')


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    browser = None
    checks = []
    try:
        browser = WorkflowBrowser(f'http://127.0.0.1:{server.server_port}/result', {}, ['127.0.0.1'], OUTPUT / 'downloads')
        time.sleep(1)
        saved = archive_page(browser, OUTPUT, OUTPUT / 'webpage', 'fixture')
        assert (OUTPUT / 'webpage/page.html').exists(), saved
        assert (OUTPUT / 'webpage/page.mhtml').exists()
        assert saved['archive']['resourceCount'] >= 3
        assert 'Official result: fixture-123' in (OUTPUT / 'webpage/page.html').read_text(encoding='utf-8')
        assert len(saved['archive']['images']) >= 2
        assert all(image['width'] == round(image['clip']['width'] * 2) for image in saved['archive']['images'])
        checks.append('original HTML, stylesheet, SVG and iframe materialized from actual Chrome MHTML')
        checks.append('long page captured at 2x pixels in PNG tiles without downscaling')
        crop = archive_page(browser, OUTPUT, OUTPUT / 'crop', 'fixture', capture_only=True, clip={'x': 0, 'y': 0, 'width': 640, 'height': 480})
        assert crop['archive']['images'][0]['width'] == 1280, crop
        assert crop['archive']['images'][0]['height'] == 960
        checks.append('640x480 original region captured as an actual 1280x960 PNG')
        context = cdp('Target.createBrowserContext', disposeOnDetach=False)['browserContextId']
        target = cdp('Target.createTarget', url='about:blank', browserContextId=context)['targetId']
        session = cdp('Target.attachToTarget', targetId=target, flatten=True)['sessionId']
        try:
            cdp('Network.enable', session_id=session)
            cdp('Network.emulateNetworkConditions', session_id=session, offline=True, latency=0, downloadThroughput=0, uploadThroughput=0)
            cdp('Page.navigate', session_id=session, url=(OUTPUT / 'webpage/page.html').as_uri())
            for _ in range(50):
                if evaluate(session, 'document.readyState') == 'complete': break
                time.sleep(.1)
            assert 'Official result: fixture-123' in evaluate(session, 'document.body.innerText')
            assert evaluate(session, 'document.querySelector("img").complete && document.querySelector("img").naturalWidth > 0')
            checks.append('saved HTML and original SVG render with network disabled in a separate Chrome context')
        finally:
            cdp('Target.disposeBrowserContext', browserContextId=context)
        assert saved['archive']['status'] == 'complete', saved['archive']
        assert 'data:image/png' in (OUTPUT / 'webpage/page.html').read_text(encoding='utf-8')
        checks.append('canvas is preserved in place as an original raster image and in the page screenshot')
        result = {'ok': True, 'checks': checks, 'archive': saved['archive'], 'output': str(OUTPUT)}
        (OUTPUT / 'validation.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps(result))
    except Exception as error:
        (OUTPUT / 'validation.json').write_text(json.dumps({'ok': False, 'checks': checks, 'error': str(error)}, indent=2), encoding='utf-8')
        raise
    finally:
        if browser:
            context = browser.browser_context
            browser.close()
            cdp('Target.disposeBrowserContext', browserContextId=context)
        server.shutdown()


if __name__ == '__main__': main()
