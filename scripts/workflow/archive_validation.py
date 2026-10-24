"""Verify saved HTML in a fresh, offline Chrome context; never execute its JS."""
from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path


INSPECT = r"""(async () => {
 await Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,5000))]);
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
 const issues=[];
 for(const e of document.images)if(visible(e)&&(!e.complete||!e.naturalWidth))issues.push('Missing image: '+e.getAttribute('src'));
 for(const e of document.querySelectorAll('link[rel~="stylesheet"]'))if(!e.disabled&&!e.sheet)issues.push('Missing stylesheet: '+e.getAttribute('href'));
 for(const f of document.fonts)if(f.status==='error'||f.status==='loading')issues.push('Missing font: '+f.family);
 if([...document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(visible)||[...document.querySelectorAll('body *')].some(e=>!e.children.length&&visible(e)&&/^(loading(?:\.{0,3}|…)?|please wait(?:\.{0,3})?)$/i.test(e.textContent.trim())))issues.push('Result still displays Loading');
 if([...document.querySelectorAll('canvas')].some(visible))issues.push('Unfrozen canvas in saved page');
 const nodes={};for(const e of document.querySelectorAll('[data-biohub-node]')){const r=e.getBoundingClientRect(),s=getComputedStyle(e);nodes[e.getAttribute('data-biohub-node')]={width:r.width,height:r.height,fontFamily:s.fontFamily,fontSize:s.fontSize,color:s.color,text:(e.innerText||e.value||'').slice(0,300)}}
 return {url:location.href,ready:document.readyState,text:document.body?.innerText||'',issues,nodes,images:document.images.length};
})()"""


def compare_baseline(actual, baseline):
    issues = list(actual.get('issues', []))
    text = re.sub(r'\s+', ' ', actual.get('text', '')).strip()
    if not text and not actual.get('images'):
        issues.append('Saved result is blank')
    if baseline:
        expected = re.sub(r'\s+', ' ', baseline.get('text', '')).strip()
        # Whitespace can change on serialization; scientific text must survive.
        if expected and text != expected:
            words = expected.split()
            retained = sum(word in text for word in words)
            if retained / max(1, len(words)) < .98:
                issues.append('Saved result text differs from the original rendered page')
        for sample in baseline.get('samples', []):
            node = actual.get('nodes', {}).get(str(sample['node']))
            if not node:
                issues.append('Original result region is missing: ' + str(sample['node']))
                continue
            if node['width'] <= 0 or node['height'] <= 0:
                issues.append('Original result region is hidden: ' + str(sample['node']))
            for key in ('fontFamily', 'fontSize', 'color'):
                if node.get(key) != sample.get(key):
                    issues.append('Saved styling differs at region ' + str(sample['node']) + ': ' + key)
            if abs(node['width'] - sample['width']) > max(12, sample['width'] * .12):
                issues.append('Saved layout differs at region ' + str(sample['node']))
    return list(dict.fromkeys(issues))


def verify_pages(pages, *, cdp=None):
    if cdp is None:
        from browser_harness.admin import ensure_daemon
        from browser_harness.helpers import cdp
        ensure_daemon()
    context = cdp('Target.createBrowserContext', disposeOnDetach=False)['browserContextId']
    results = []
    try:
        for page in pages:
            result = {'path': page['path'], 'itemId': page.get('itemId'), 'status': 'partial', 'issues': []}
            target = None
            try:
                file = Path(page['path']).resolve(strict=True)
                digest = hashlib.sha256(file.read_bytes()).hexdigest()
                if page.get('sha256') and page['sha256'] != digest:
                    raise ValueError('Saved page checksum changed')
                target = cdp('Target.createTarget', url='about:blank', browserContextId=context, background=True)['targetId']
                session = cdp('Target.attachToTarget', targetId=target, flatten=True)['sessionId']
                cdp('Page.enable', session_id=session)
                cdp('Network.enable', session_id=session)
                cdp('Network.setCacheDisabled', session_id=session, cacheDisabled=True)
                cdp('Network.setBypassServiceWorker', session_id=session, bypass=True)
                cdp('Network.setBlockedURLs', session_id=session, urls=['http://*', 'https://*', 'ftp://*', 'ws://*', 'wss://*'])
                cdp('Network.emulateNetworkConditions', session_id=session, offline=True, latency=0, downloadThroughput=0, uploadThroughput=0)
                cdp('Emulation.setScriptExecutionDisabled', session_id=session, value=True)
                viewport = (page.get('baseline') or {}).get('viewport') or {'width': 1280, 'height': 900}
                cdp('Emulation.setDeviceMetricsOverride', session_id=session, width=viewport['width'], height=viewport['height'], deviceScaleFactor=1, mobile=False)
                cdp('Page.navigate', session_id=session, url=file.as_uri())
                deadline = time.monotonic() + 15
                while True:
                    check = cdp('Runtime.evaluate', session_id=session, expression='({url:location.href,ready:document.readyState})', returnByValue=True).get('result', {}).get('value', {})
                    if check.get('url') == file.as_uri() and check.get('ready') == 'complete':
                        break
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Saved result did not load offline')
                    time.sleep(.1)
                response = cdp('Runtime.evaluate', session_id=session, expression=INSPECT, awaitPromise=True, returnByValue=True)
                if response.get('exceptionDetails'):
                    raise ValueError('Could not inspect offline document')
                actual = response['result']['value']
                # Local file frames have distinct opaque origins. Inspect via
                # CDP frame contexts instead of wrongly treating DOM access
                # restrictions as a missing frame.
                frame_tree = cdp('Page.getFrameTree', session_id=session)['frameTree']
                def inspect_frames(branch):
                    for child in branch.get('childFrames', []):
                        frame = child['frame']
                        try:
                            world = cdp('Page.createIsolatedWorld', session_id=session, frameId=frame['id'], worldName='biohub-offline-check')['executionContextId']
                            check = cdp('Runtime.evaluate', session_id=session, contextId=world, expression=INSPECT, awaitPromise=True, returnByValue=True)
                            value = check.get('result', {}).get('value')
                            if not value or frame.get('unreachableUrl') or frame.get('url', '').startswith('chrome-error:'):
                                raise ValueError('Offline iframe is unavailable')
                            actual['issues'].extend(value['issues'])
                        except Exception as error:
                            actual['issues'].append('Iframe: ' + str(error)[:160])
                        inspect_frames(child)
                inspect_frames(frame_tree)
                result.update(sha256=digest, textSha256=hashlib.sha256(actual['text'].encode()).hexdigest(),
                              issues=compare_baseline(actual, page.get('baseline')))
                result['status'] = 'partial' if result['issues'] else 'complete' if page.get('baseline') else 'unverified'
                if not page.get('baseline'):
                    result['issues'].append('Original rendered baseline is missing; visual fidelity is unverified')
            except Exception as error:
                result['issues'].append(str(error)[:500])
            finally:
                if target:
                    try:
                        cdp('Target.closeTarget', targetId=target)
                    except Exception:
                        pass
            results.append(result)
    finally:
        cdp('Target.disposeBrowserContext', browserContextId=context)
    return {'pages': results, 'status': 'complete' if results and all(p['status'] == 'complete' for p in results) else 'partial',
            'verifiedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'offline': True, 'scriptsDisabled': True}
