"""One visible Chrome window for saved result pages; no analysis submission."""
from __future__ import annotations

import hashlib
import time
from pathlib import Path


def open_pages(pages, state=None, *, cdp=None, prune=False):
    if cdp is None:
        from browser_harness.admin import ensure_daemon
        from browser_harness.helpers import cdp
        ensure_daemon()
    state = dict(state or {})
    targets = {t['targetId']: t for t in cdp('Target.getTargets')['targetInfos']}
    contexts = cdp('Target.getBrowserContexts')['browserContextIds']
    context = state.get('browserContextId')
    if context not in contexts:
        context = cdp('Target.createBrowserContext', disposeOnDetach=False)['browserContextId']
        state = {'browserContextId': context, 'tabs': {}}
    tabs = state.setdefault('tabs', {})
    if prune:
        wanted = {p['key'] for p in pages}
        for key in list(tabs):
            if key in wanted:
                continue
            target = targets.get(tabs[key].get('targetId'))
            if target and target.get('browserContextId') == context:
                cdp('Target.closeTarget', targetId=target['targetId'])
                targets.pop(target['targetId'], None)
            tabs.pop(key, None)
    window_id, opened, failed = None, [], []
    for page in pages:
        target = None
        created_here = False
        try:
            file = Path(page['path']).resolve(strict=True)
            if hashlib.sha256(file.read_bytes()).hexdigest() != page['sha256']:
                raise ValueError('Saved page changed after verification')
            url = file.as_uri()
            previous = tabs.get(page['key'], {})
            owned = targets.get(previous.get('targetId'))
            if owned and owned.get('browserContextId') == context and owned.get('url') == url and previous.get('sha256') == page['sha256']:
                target = owned['targetId']
            else:
                target = cdp('Target.createTarget', url='about:blank', browserContextId=context,
                             newWindow=not any(t.get('browserContextId') == context for t in targets.values()),
                             background=False)['targetId']
                created_here = True
                session = cdp('Target.attachToTarget', targetId=target, flatten=True)['sessionId']
                try:
                    # Saved POST responses and scripts must never re-run on open.
                    cdp('Page.enable', session_id=session)
                    cdp('Emulation.setScriptExecutionDisabled', session_id=session, value=True)
                    cdp('Network.enable', session_id=session)
                    cdp('Network.emulateNetworkConditions', session_id=session, offline=True, latency=0,
                        downloadThroughput=0, uploadThroughput=0)
                    cdp('Page.navigate', session_id=session, url=url)
                    deadline = time.monotonic() + 15
                    while True:
                        response = cdp('Runtime.evaluate', session_id=session,
                                       expression="({url:location.href,ready:document.readyState,text:document.body?.innerText?.length||0})", returnByValue=True)
                        value = response.get('result', {}).get('value', {})
                        if value.get('url') == url and value.get('ready') == 'complete':
                            if not value.get('text') and not file.stat().st_size:
                                raise ValueError('Saved page is empty')
                            break
                        if time.monotonic() >= deadline:
                            raise TimeoutError('Saved page did not finish loading')
                        time.sleep(.1)
                finally:
                    cdp('Target.detachFromTarget', sessionId=session)
                targets[target] = {'targetId': target, 'browserContextId': context, 'url': url}
            current_window = cdp('Browser.getWindowForTarget', targetId=target)['windowId']
            if window_id is not None and current_window != window_id:
                raise ValueError('Result tab opened outside the delivery window')
            window_id = current_window
            tabs[page['key']] = {'targetId': target, 'sha256': page['sha256']}
            opened.append({'itemId': page['itemId'], 'path': page['key'], 'targetId': target, 'windowId': window_id})
        except Exception as error:
            if created_here and target:
                try:
                    cdp('Target.closeTarget', targetId=target)
                    targets.pop(target, None)
                except Exception:
                    pass
            failed.append({'itemId': page['itemId'], 'path': page['key'], 'message': str(error)[:500]})
    if opened:
        cdp('Browser.setWindowBounds', windowId=window_id, bounds={'windowState': 'normal'})
        cdp('Target.activateTarget', targetId=opened[0]['targetId'])
    state['windowId'] = window_id
    return {'opened': len(opened), 'pages': opened, 'failed': failed, 'windowId': window_id, 'state': state}
