"""Recover resources actually loaded by Chrome but omitted from its MHTML.

Only observed page resources are read. This never navigates, submits a form or
guesses a service endpoint. Fonts are embedded by the materializer so file://
archives work without relaxing Chrome's local-file origin policy.
"""
from __future__ import annotations

import base64
import re
from urllib.parse import urldefrag, urljoin, urlparse

MAX_RESOURCE = 32 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024


def collect_resources(browser, used_urls):
    browser.call('Page.enable')
    browser.call('Network.enable')
    tree = browser.call('Page.getResourceTree')['frameTree']
    candidates = {}
    def visit(branch):
        frame = branch['frame']['id']
        for resource in branch.get('resources', []):
            if (resource.get('type') in {'Stylesheet', 'Font', 'Document'} or resource.get('type') == 'Image' and resource['url'] in used_urls) and resource['url'].startswith(('http://', 'https://', 'blob:')):
                candidates[urldefrag(resource['url'])[0]] = (frame, resource.get('mimeType', 'application/octet-stream'))
        for child in branch.get('childFrames', []):
            visit(child)
    visit(tree)
    for url in used_urls:
        if url.startswith(('http://', 'https://', 'blob:')):
            candidates.setdefault(urldefrag(url)[0], (tree['frame']['id'], 'application/octet-stream'))
    resources, failures, total = {}, [], 0
    queue = list(candidates)
    index = 0
    while index < min(len(queue), 512):
        url = queue[index]; index += 1
        frame, mime = candidates[url]
        if total >= MAX_TOTAL:
            failures.append({'url': url, 'reason': 'Archive resource size limit exceeded'})
            continue
        try:
            try:
                result = browser.call('Page.getResourceContent', frameId=frame, url=url)
                data = base64.b64decode(result['content']) if result.get('base64Encoded') else result['content'].encode('utf-8')
            except Exception:
                if not url.startswith(('http://', 'https://')):
                    raise
                result = browser.call('Network.loadNetworkResource', frameId=frame, url=url,
                                      options={'disableCache': False, 'includeCredentials': True})['resource']
                if not result.get('success') or result.get('httpStatusCode', 200) >= 400 or not result.get('stream'):
                    raise ValueError('Chrome could not retrieve the observed resource')
                stream, chunks, size = result['stream'], [], 0
                try:
                    while True:
                        chunk = browser.call('IO.read', handle=stream, size=256 * 1024)
                        part = base64.b64decode(chunk['data']) if chunk.get('base64Encoded') else chunk['data'].encode('utf-8')
                        size += len(part)
                        if size > MAX_RESOURCE:
                            raise ValueError('Resource size limit exceeded')
                        chunks.append(part)
                        if chunk.get('eof'):
                            break
                    data = b''.join(chunks)
                finally:
                    browser.call('IO.close', handle=stream)
                headers = {k.lower(): v for k, v in result.get('headers', {}).items()}
                mime = headers.get('content-type', mime).split(';')[0]
            if not data or len(data) > MAX_RESOURCE or total + len(data) > MAX_TOTAL:
                raise ValueError('Empty or oversized resource')
            total += len(data)
            resources[url] = {'data': data, 'mime': mime}
            # CSS references are observed resources too. Recover nested imports
            # and font variants even if Chromium omitted them from its tree.
            if mime == 'text/css' or urlparse(url).path.endswith('.css'):
                text = data.decode('utf-8', errors='replace')
                references = [m[1] for m in re.findall(r'url\(\s*([\'"]?)(.*?)\1\s*\)', text, re.I)]
                references += [m[1] for m in re.findall(r'@import\s+([\'"])(.*?)\1', text, re.I)]
                for reference in references:
                    linked = urldefrag(urljoin(url, reference))[0]
                    if linked.startswith(('http://', 'https://')) and linked not in candidates:
                        candidates[linked] = (frame, 'application/octet-stream'); queue.append(linked)
        except Exception as error:
            failures.append({'url': url, 'reason': str(error)[:180]})
    return resources, failures
