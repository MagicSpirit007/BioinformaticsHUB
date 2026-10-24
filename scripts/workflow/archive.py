"""Original-page archives and unscaled PNG captures from the owned Chrome tab."""
from __future__ import annotations

import base64
import hashlib
import html
import json
import math
import mimetypes
import re
import struct
import time
from email import policy
from email.parser import BytesParser
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urldefrag, unquote, urlparse

from .artifacts import descriptor, write_json


class OfflineHTML(HTMLParser):
    def __init__(self, rewrite, css):
        super().__init__(convert_charrefs=False)
        self.rewrite, self.css = rewrite, css
        self.output, self.skip, self.in_style = [], 0, False

    def handle_starttag(self, tag, attrs):
        if tag.lower() == "script":
            self.skip += 1
            return
        if self.skip:
            return
        if tag.lower() == "base":
            return
        if tag.lower() == "meta" and any(k == "http-equiv" and str(v).lower() in {"refresh", "content-security-policy"} for k, v in attrs):
            return
        self.in_style = tag.lower() == "style"
        values = []
        for key, value in attrs:
            if key.lower().startswith("on") or key.lower() in {'integrity', 'crossorigin'}:
                continue
            if value is not None:
                if key in {"src", "poster", "background", "data"} or key in {"href", "xlink:href"} and tag.lower() in {"link", "image", "use"}:
                    value = self.rewrite(value)
                elif key == "href" and value.lower().startswith("javascript:"):
                    value = "#"
                elif key == "srcset" and "data:" not in value:
                    value = ", ".join(self.rewrite(x.strip().split()[0]) + (" " + " ".join(x.strip().split()[1:]) if len(x.strip().split()) > 1 else "") for x in value.split(",") if x.strip())
                elif key == "style":
                    value = self.css(value)
                elif key == "action":
                    value = "#"
            values.append(key if value is None else f'{key}="{html.escape(value, quote=True)}"')
        self.output.append("<" + tag + (" " + " ".join(values) if values else "") + ">")

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag.lower() == "script":
            self.skip = max(0, self.skip - 1)
            return
        if self.skip:
            return
        if tag.lower() == "style":
            self.in_style = False
        self.output.append(f"</{tag}>")

    def handle_data(self, data):
        if not self.skip:
            self.output.append(self.css(data) if self.in_style else data)

    def handle_decl(self, decl):
        self.output.append("<!" + decl + ">")

    def handle_entityref(self, name):
        if not self.skip:
            self.output.append("&" + name + ";")

    def handle_charref(self, name):
        if not self.skip:
            self.output.append("&#" + name + ";")


OFFLINE_POLICY = "default-src 'none'; img-src 'self' file: data:; style-src 'self' file: data: 'unsafe-inline'; font-src 'self' file: data:; frame-src 'self' file: data:; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'"


def materialize_mhtml(data: bytes, output: Path, source_url: str, frozen_html=None, resources=None, frozen_frames=None) -> dict:
    """Decode Chromium MIME resources; rewrite their original URLs to local files."""
    output.mkdir(parents=True, exist_ok=True)
    archive = BytesParser(policy=policy.default).parsebytes(data)
    parts = [part for part in archive.walk() if not part.is_multipart() and part.get_payload(decode=True) is not None]
    pages = [part for part in parts if part.get_content_type() in {"text/html", "application/xhtml+xml"}]
    if not pages:
        raise ValueError("Chrome archive contains no HTML document")
    main = next((part for part in pages if urldefrag(str(part.get("Content-Location", "")))[0] == urldefrag(source_url)[0]), pages[0])
    mapping, records, font_data = {}, [], {}
    for index, part in enumerate(parts):
        location = urljoin(source_url, str(part.get("Content-Location", "")))
        cid = str(part.get("Content-ID", "")).strip("<>")
        mime = part.get_content_type()
        extension = {"text/html": ".html", "text/css": ".css", "image/svg+xml": ".svg"}.get(mime) or mimetypes.guess_extension(mime) or ".bin"
        name = "page.html" if part is main else "assets/" + hashlib.sha256((location + str(index)).encode()).hexdigest()[:24] + extension
        mapping[urldefrag(location)[0]] = name
        if cid:
            mapping["cid:" + cid] = name
        records.append((part, location, name))
    # Chromium MHTML omits fonts, and may omit lazily loaded page images.
    # Supplement from Chrome's actual resource tree, never guessed URLs.
    from email.message import EmailMessage
    for location, resource in (resources or {}).items():
        location = urldefrag(location)[0]
        mime = resource['mime']
        if mime == 'application/octet-stream':
            mime = mimetypes.guess_type(urlparse(location).path)[0] or mime
        if mime.startswith('font/') or re.search(r'\.(?:woff2?|ttf|otf)(?:\?|$)', location, re.I):
            font_data[location] = 'data:' + mime + ';base64,' + base64.b64encode(resource['data']).decode()
        if location in mapping:
            continue
        part = EmailMessage()
        part.set_content(resource['data'], maintype=mime.split('/')[0], subtype=mime.split('/')[-1])
        extension = {'text/css': '.css', 'image/svg+xml': '.svg'}.get(mime) or mimetypes.guess_extension(mime) or '.bin'
        name = 'assets/' + hashlib.sha256(location.encode()).hexdigest()[:24] + extension
        mapping[location] = name
        records.append((part, location, name))
    missing = set()

    def rewriters(location, name):
        def rewrite(value):
            if not value or value.startswith(("data:", "#", "about:")):
                return value
            absolute, fragment = urldefrag(urljoin(location, value))
            if absolute in font_data:
                return font_data[absolute]
            target = mapping.get(absolute) or mapping.get(unquote(absolute))
            if target:
                import posixpath
                relative = posixpath.relpath(target, str(Path(name).parent).replace("\\", "/"))
                return relative + ("#" + fragment if fragment else "")
            if absolute.startswith(("http:", "https:", "cid:")):
                missing.add(absolute)
            return value

        def css(value):
            value = re.sub(r"url\(\s*(['\"]?)(.*?)\1\s*\)", lambda match: 'url("' + rewrite(match[2]) + '")', value, flags=re.I)
            return re.sub(r"(@import\s+)(['\"])(.*?)\2", lambda match: match[1] + '"' + rewrite(match[3]) + '"', value, flags=re.I)
        return rewrite, css

    for part, location, name in records:
        payload = part.get_payload(decode=True)
        mime = part.get_content_type()
        rewrite, css = rewriters(location, name)
        if mime in {"text/html", "application/xhtml+xml", "text/css"}:
            text = frozen_html if part is main and frozen_html is not None else (frozen_frames or {}).get(location) or payload.decode(part.get_content_charset() or "utf-8", errors="replace")
            if mime == "text/css":
                payload = css(text).encode("utf-8")
            else:
                parser = OfflineHTML(rewrite, css)
                parser.feed(text)
                content = ''.join(parser.output)
                security = '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + OFFLINE_POLICY + '">'
                content = re.sub(r'<head(?:\s[^>]*)?>', lambda m: m[0] + security, content, count=1, flags=re.I) if re.search(r'<head(?:\s[^>]*)?>', content, re.I) else security + content
                payload = content.encode('utf-8')
        destination = output / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(payload)
    return {"html": "page.html", "resourceCount": len(records) - 1, "embeddedFonts": len(font_data), "missingResources": sorted(missing),
            "offlineReadable": not missing, "interactive": False}


def png_dimensions(data):
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Chrome did not return a PNG")
    return struct.unpack(">II", data[16:24])


def capture_pngs(browser, output: Path, *, scale=2, clip=None):
    if type(scale) not in {int, float} or not 1 <= scale <= 4:
        raise ValueError("Screenshot scale must be between 1 and 4")
    if clip is not None and (not isinstance(clip, dict) or any(type(clip.get(k)) not in {int, float} or not math.isfinite(clip[k]) for k in ("x", "y", "width", "height")) or clip["x"] < 0 or clip["y"] < 0 or clip["width"] <= 0 or clip["height"] <= 0):
        raise ValueError("Screenshot clip needs nonnegative x/y and positive width/height")
    original = browser.evaluate("({width:innerWidth,height:innerHeight,scale:devicePixelRatio})")
    metrics = browser.call("Page.getLayoutMetrics")
    size = metrics.get("cssContentSize", metrics.get("contentSize", {}))
    region = clip or {"x": 0, "y": 0, "width": size["width"], "height": size["height"]}
    if region["width"] * scale > 16384:
        raise ValueError("Capture width exceeds 16384 pixels; select a narrower region")
    output.mkdir(parents=True, exist_ok=True)
    images = []
    try:
        browser.call("Emulation.setDeviceMetricsOverride", width=original["width"], height=original["height"], deviceScaleFactor=scale, mobile=False)
        browser.call("Runtime.evaluate", expression="document.fonts.ready.then(()=>true)", awaitPromise=True, returnByValue=True)
        height = min(region["height"], 4096 / scale)
        pieces = math.ceil(region["height"] / height)
        for index in range(pieces):
            part = {**region, "y": region["y"] + index * height, "height": min(height, region["height"] - index * height), "scale": 1}
            data = base64.b64decode(browser.call("Page.captureScreenshot", format="png", captureBeyondViewport=True, clip=part)["data"])
            width_px, height_px = png_dimensions(data)
            if width_px < round(region["width"] * scale) - 1 or height_px < round(part["height"] * scale) - 1:
                raise ValueError("Chrome returned a lower-resolution capture than requested")
            file = output / ("page.png" if pieces == 1 else f"page-{index + 1:03d}.png")
            file.write_bytes(data)
            images.append({"name": file.name, "width": width_px, "height": height_px, "scale": scale, "clip": {k: v for k, v in part.items() if k != "scale"}})
    finally:
        browser.call("Emulation.setDeviceMetricsOverride", width=original["width"], height=original["height"], deviceScaleFactor=original["scale"], mobile=False)
    return images


# Clone the rendered DOM; serialization must not change a live scientific form.
FREEZE_DOCUMENT = r"""(() => {
 const clone=document.documentElement.cloneNode(true), source=[...document.querySelectorAll('*')], target=[clone,...clone.querySelectorAll('*')];
 const issues=[], missing=[], used=[], raster=[], samples=[];
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
 let charts=0, unknownCanvas=false;
 source.forEach((e,i)=>{
   const c=target[i];if(!c)return;
   c.setAttribute('data-biohub-node',String(i));
   if(e.tagName==='STYLE'){try{c.textContent=[...e.sheet.cssRules].map(r=>r.cssText).join('\n')}catch(_){}}
   if(e.tagName==='IMG'&&e.currentSrc){c.setAttribute('src',e.currentSrc);c.removeAttribute('srcset');c.setAttribute('loading','eager');}
   if(e.tagName==='INPUT') {if(e.type==='password'||e.type==='file')c.removeAttribute('value');else c.setAttribute('value',e.value);if(e.checked)c.setAttribute('checked','');else c.removeAttribute('checked');}
   if(e.tagName==='TEXTAREA')c.textContent=e.value;
   if(e.tagName==='OPTION'){if(e.selected)c.setAttribute('selected','');else c.removeAttribute('selected');}
   if(e.tagName==='LINK'&&e.relList?.contains('stylesheet')&&!e.disabled){used.push(e.href);if(!e.sheet)issues.push('Stylesheet did not load');}
   if(e.tagName==='image'&&visible(e)&&e.href?.baseVal)used.push(new URL(e.href.baseVal,location.href).href);
   if(e.tagName==='IMG'&&visible(e)){used.push(e.currentSrc||e.src);if(!e.complete||!e.naturalWidth)missing.push(e.currentSrc||e.src);}
   if(e.tagName==='CANVAS'&&visible(e)){
     charts++;
     try {const img=document.createElement('img');img.src=e.toDataURL('image/png');img.setAttribute('style',c.getAttribute('style')||'');img.width=e.width;img.height=e.height;img.alt=e.getAttribute('aria-label')||'Saved original canvas';c.replaceWith(img);
       img.setAttribute('data-biohub-node',String(i));img.style.width=e.getBoundingClientRect().width+'px';img.style.height=e.getBoundingClientRect().height+'px';
       const ctx=e.getContext('2d');if(ctx){const d=ctx.getImageData(0,0,e.width,e.height).data;let painted=false;for(let k=3;k<d.length;k+=4)if(d[k]&&!(d[k-3]>250&&d[k-2]>250&&d[k-1]>250)){painted=true;break;}if(!painted)issues.push('Blank canvas');}else {unknownCanvas=true;const r=e.getBoundingClientRect();raster.push({node:i,x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height});img.src='biohub-raster:'+i;}
     }catch(_){const r=e.getBoundingClientRect();raster.push({node:i,x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height});c.outerHTML='<img data-biohub-node="'+i+'" src="biohub-raster:'+i+'" style="width:'+r.width+'px;height:'+r.height+'px" alt="Static original chart">';unknownCanvas=true;}
   }
   if(e.tagName==='svg'&&visible(e))charts++;
   if(visible(e)) {const style=getComputedStyle(e);for(const ps of [null,'::before','::after']){const bg=getComputedStyle(e,ps).backgroundImage;for(const m of bg.matchAll(/url\(["']?(.*?)["']?\)/g))used.push(new URL(m[1],location.href).href);}
     if(samples.length<80&&/^(H1|H2|H3|TABLE|TEXTAREA|IMG|svg)$/.test(e.tagName)){const r=e.getBoundingClientRect();samples.push({node:i,tag:e.tagName,width:r.width,height:r.height,fontFamily:style.fontFamily,fontSize:style.fontSize,color:style.color,text:(e.innerText||e.value||'').slice(0,300)});}
     if(e.shadowRoot){const r=e.getBoundingClientRect();raster.push({node:i,x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height});c.innerHTML='<img src="biohub-raster:'+i+'" style="width:'+r.width+'px;height:'+r.height+'px" alt="Static original shadow content">';}
   }
 });
 for(const sheet of document.adoptedStyleSheets||[]){const s=document.createElement('style');try{s.textContent=[...sheet.cssRules].map(r=>r.cssText).join('\n');clone.querySelector('head').appendChild(s)}catch(_){issues.push('Constructed stylesheet unavailable')}}
 for(const e of performance.getEntriesByType('resource'))if(/\.(?:woff2?|ttf|otf)(?:\?|$)/i.test(e.name))used.push(e.name);
 const loading=[...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some(visible)||[...document.querySelectorAll('body *')].some(e=>e.children.length===0&&visible(e)&&/^(loading(?:\.{0,3}|…)?|please wait(?:\.{0,3})?)$/i.test(e.textContent.trim()));
 if(loading)issues.push('Result still displays Loading or an active progress indicator');
 if(missing.length)issues.push('Visible images are missing or still loading');
 return {html:'<!doctype html>\n'+clone.outerHTML,sourceUrl:location.href,usedResources:[...new Set(used)],missingImages:missing,raster,samples,text:document.body?.innerText||'',visual:{status:issues.length?'partial':unknownCanvas?'unverified':charts||used.length?'complete':'not_applicable',issues},canvas:charts>0,shadow:source.some(e=>e.shadowRoot)};
})()"""

def freeze_document(browser):
    # Wait only on observed loading indicators, with a bounded deadline.
    browser.call('Runtime.evaluate', expression='Promise.race([document.fonts.ready.then(()=>true),new Promise(r=>setTimeout(()=>r(false),10000))])', awaitPromise=True, returnByValue=True)
    deadline = time.monotonic() + 20
    while True:
        result = browser.evaluate(FREEZE_DOCUMENT)
        if not result:
            raise ValueError('Could not inspect the original document')
        if not result['visual']['issues'] or time.monotonic() >= deadline:
            return result
        time.sleep(.4)


def archive_page(browser, root: Path, output: Path, node_id: str, *, capture_only=False, scale=2, clip=None):
    # Always capture the top-level result, even if the executor last inspected a frame.
    old_session, old_context = browser.session, getattr(browser, "context_id", None)
    browser.session = getattr(browser, "top_session", browser.session)
    browser.context_id = None
    output.mkdir(parents=True, exist_ok=True)
    metadata = {"status": "complete", "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "errors": []}
    try:
        metadata["sourceUrl"] = browser.result_url() if hasattr(browser, 'result_url') else browser.evaluate("location.href")
        metadata["title"] = browser.evaluate("document.title")
        browser.assert_url(metadata["sourceUrl"])
        frozen = freeze_document(browser)
        for region in frozen.get('raster', []):
            try:
                raster_clip = {key: region[key] for key in ('x', 'y', 'width', 'height')}
                if raster_clip['x'] < 0 or raster_clip['y'] < 0 or raster_clip['width'] <= 0 or raster_clip['height'] <= 0:
                    raise ValueError('Invalid original chart bounds')
                data = browser.call('Page.captureScreenshot', format='png', captureBeyondViewport=True, clip={**raster_clip, 'scale': 1})['data']
                frozen['html'] = frozen['html'].replace('biohub-raster:' + str(region['node']) + '"', 'data:image/png;base64,' + data + '"')
            except Exception as error:
                frozen['visual']['issues'].append('Static chart capture failed: ' + str(error)[:180])
        if frozen.get('raster'):
            frozen['visual']['status'] = 'partial' if frozen['visual']['issues'] else 'complete'
            metadata['staticRegions'] = len(frozen['raster'])
        metadata['baseline'] = {'text': frozen['text'], 'samples': frozen['samples'], 'viewport': browser.evaluate('({width:innerWidth,height:innerHeight})')}
        metadata['visual'] = frozen['visual']
        metadata['interactive'] = False
        if frozen['visual']['status'] in {'partial', 'unverified'}:
            metadata['status'] = 'partial'
            metadata['errors'].extend(frozen['visual']['issues'])
        if not capture_only:
            try:
                mhtml = browser.call("Page.captureSnapshot", format="mhtml")["data"].encode("utf-8")
                (output / "page.mhtml").write_bytes(mhtml)
                from .archive_resources import collect_resources
                resources, failures = collect_resources(browser, frozen['usedResources'])
                metadata['resourceRecoveryFailures'] = failures
                frames = {}
                def freeze_frames(branch):
                    for child in branch.get('childFrames', []):
                        try:
                            frame = child['frame']
                            world = browser.call('Page.createIsolatedWorld', frameId=frame['id'], worldName='biohub-freeze')['executionContextId']
                            result = browser.call('Runtime.evaluate', contextId=world, expression=FREEZE_DOCUMENT, returnByValue=True).get('result', {}).get('value')
                            if not result or result.get('raster'):
                                raise ValueError('Nested dynamic chart needs a separate original-page capture')
                            frames[frame['url']] = result['html']
                            metadata['errors'].extend(result['visual']['issues'])
                        except Exception as error:
                            metadata['errors'].append('Frame capture: ' + str(error)[:180])
                        freeze_frames(child)
                freeze_frames(browser.call('Page.getFrameTree')['frameTree'])
                if metadata['errors']:
                    metadata['status'] = 'partial'
                metadata.update(materialize_mhtml(mhtml, output, metadata["sourceUrl"], frozen["html"], resources=resources, frozen_frames=frames))
                # Unused stylesheet alternatives and favicons do not invalidate visible results.
                missing = set(metadata["missingResources"])
                metadata["criticalMissingResources"] = sorted(missing.intersection(frozen["usedResources"]))
                metadata["offlineReadable"] = not metadata["criticalMissingResources"] and not frozen["missingImages"]
                if not metadata["offlineReadable"]:
                    metadata["status"] = "partial"
                    metadata["errors"].append(f'{len(metadata["criticalMissingResources"])} visible resource(s) were not available in Chrome.')
            except Exception as error:
                metadata["errors"].append("HTML archive: " + str(error)[:300])
                metadata["status"] = "partial"
        try:
            metadata["images"] = capture_pngs(browser, output, scale=scale, clip=clip)
        except Exception as error:
            metadata["errors"].append("PNG capture: " + str(error)[:300])
            metadata["status"] = "partial"
        if not capture_only and (output / 'page.html').exists():
            try:
                from .archive_validation import verify_pages
                verification = verify_pages([{'path': str((output / 'page.html').resolve()), 'baseline': metadata['baseline']}])['pages'][0]
                metadata['offlineVerification'] = verification
                metadata['offlineReadable'] = verification['status'] == 'complete'
                if verification['status'] != 'complete':
                    metadata['status'] = 'partial'
                    metadata['errors'].extend(verification['issues'])
            except Exception as error:
                metadata['status'] = 'partial'
                metadata['offlineReadable'] = False
                metadata['errors'].append('Offline verification failed: ' + str(error)[:300])
        write_json(output / "archive.json", metadata)
        artifacts = []
        for file in output.rglob('*'):
            if not file.is_file():
                continue
            artifact = descriptor(root, file, 'report', node_id, metadata['sourceUrl'])
            artifact['role'] = 'internal' if file.suffix.lower() == '.json' else 'resource' if file.is_relative_to(output / 'assets') else 'page' if file.suffix.lower() in {'.html', '.mhtml'} else 'figure'
            artifacts.append(artifact)
        metadata["path"] = output.relative_to(root).as_posix()
        return {"archive": metadata, "artifacts": artifacts}
    finally:
        browser.session, browser.context_id = old_session, old_context
