"""Opt-in live 28-site form audit through vendored Jev. Never submits forms."""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from workflow_worker import configure


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--chrome-url', required=True)
    parser.add_argument('--sites', default='')
    parser.add_argument('--output', default='runs/site-audit')
    args = parser.parse_args()
    configure({'envFile': str(Path.home() / 'jev-ultrafast' / '.env'), 'chromeUrl': args.chrome_url})
    from workflow.browser import WorkflowBrowser
    from vendor.jev_ultrafast import Agent
    from browser_harness.helpers import cdp

    root = Path(__file__).resolve().parents[1]
    out = (root / args.output).resolve()
    if not out.is_relative_to(root / 'runs'):
        raise ValueError('Audit output must be inside runs/')
    out.mkdir(parents=True, exist_ok=True)
    catalog = json.loads((root / 'apps/bioinformatics-hub/public/site-catalog.json').read_text(encoding='utf-8'))
    recipes = json.loads((root / 'apps/bioinformatics-hub/public/workflow-recipes.json').read_text(encoding='utf-8'))['recipes']
    selected = set(args.sites.split(',')) if args.sites else None
    rows = []
    for site in catalog['sites']:
        if selected and site['id'] not in selected:
            continue
        site = {**site, 'entryUrl':recipes[site['id']].get('entryUrl',site['entryUrl'])}
        browser = None
        record = {'siteId': site['id'], 'entryUrl': site['entryUrl'], 'checkedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'analysisVerified': False}
        print(json.dumps({'checking': site['id']}), flush=True)
        try:
            from urllib.parse import urlparse
            hosts = [urlparse(site['entryUrl']).hostname, *recipes[site['id']].get('allowedHosts', [])]
            browser = WorkflowBrowser(site['entryUrl'], {}, hosts, out / site['id'] / 'downloads')
            page = browser.observe(False)
            # Allow Jev to inspect the genuine form. Execution is read-only (scroll,
            # wait, frame switches); any proposed mutation ends the audit first.
            def readonly(action, _page, _text):
                if action['kind'] not in {'wait', 'scroll', 'frame'}:
                    raise ValueError('Form audit stopped before a proposed browser mutation: ' + action['label'])
            agent = Agent(site['entryUrl'], 'Inspect this official bioinformatics analysis page. Scroll to identify the input sequence/file/accession control and parameter fields. DONE when visible. Do not fill, upload, click Submit, or start any job.', browser=browser, before_action=readonly, text_resolver=lambda *_: '', max_actions=4, max_decisions=8)
            try:
                for state in agent.run():
                    record['jevStatus'] = state['status']
            except Exception as exc:
                record['jevStop'] = str(exc)[:500]
            page = browser.observe(False)
            observed = browser.document_evidence()
            record.update(status='form_observed' if any(a['kind'] in {'fill','upload'} for a in page['actions']) else 'needs_inspection', finalUrl=page['url'], title=page['title'], text=observed['text'][:16000], controls=[{k:a[k] for k in ('kind','label','value','role') if k in a} for a in page['actions']])
            browser.screenshot(out / site['id'] / 'page.png')
        except Exception as exc:
            record.update(status='blocked', reason=str(exc)[:1500])
        finally:
            if browser:
                cdp('Target.disposeBrowserContext', browserContextId=browser.browser_context)
                browser.close()
        rows.append(record)
        (out / 'matrix.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'siteId': site['id'], 'status': record['status'], 'reason': record.get('reason'), 'title': record.get('title')}), flush=True)
    return 0


if __name__ == '__main__':
    main()
