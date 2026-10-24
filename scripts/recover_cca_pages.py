"""Read-only recovery of existing public/result URLs. Never fills or submits forms."""
import argparse
import json
import os
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--chrome-url', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1] / 'runs/cca0737s0009-26items-20261019'
os.environ['BU_CDP_URL'] = args.chrome_url
os.environ['BU_NAME'] = 'bioinformatics-hub'
os.environ['BH_UPDATE_CHECK'] = '0'
from workflow.browser import WorkflowBrowser
from workflow.archive import archive_page
from browser_harness.helpers import cdp

results = []
for item, url, hosts, marker in [
    ('quickgo', 'https://www.ebi.ac.uk/QuickGO/term/GO:0003700', ['www.ebi.ac.uk', 'ebi.ac.uk'], 'DNA-binding transcription factor activity'),
    ('tmhmm', 'https://services.healthtech.dtu.dk/cgi-bin/webface2.cgi?jobid=6AD61864001EE2284D0CC522&wait=20', ['services.healthtech.dtu.dk'], 'Number of predicted TMHs'),
]:
    browser = None
    output = root / 'recovered-pages' / item
    output.mkdir(parents=True, exist_ok=True)
    record = {'id': item, 'url': url, 'retrievedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'method': 'GET existing URL; no submission'}
    try:
        browser = WorkflowBrowser(url, {}, hosts, output / 'downloads')
        deadline = time.monotonic() + 20
        while True:
            evidence = browser.document_evidence()
            if marker.lower() in evidence['text'].lower(): break
            if time.monotonic() >= deadline: raise ValueError('Existing URL no longer exposes verified original result markers')
            time.sleep(.5)
        saved = archive_page(browser, root, output / 'webpage', item)
        record.update(status='saved', archive=saved['archive'], artifacts=saved['artifacts'])
    except Exception as error:
        record.update(status='unavailable', message=type(error).__name__ + ': ' + str(error)[:500])
    finally:
        if browser:
            context = browser.browser_context; browser.close()
            try: cdp('Target.disposeBrowserContext', browserContextId=context)
            except Exception: pass
    (output / 'verification.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
    results.append({k:v for k,v in record.items() if k not in {'archive','artifacts'}})
print(json.dumps(results, ensure_ascii=False))
