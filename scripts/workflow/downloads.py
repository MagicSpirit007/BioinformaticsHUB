"""Per-worker CDP download events; never drain another worker's harness events."""
from __future__ import annotations
import asyncio
import threading
import hashlib
import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree
from urllib.parse import urlparse


def verify_files(files):
    """Validate actual finished bytes, not just their names or existence."""
    from .artifacts import validate_content, fasta_records
    issues, checked = [], []
    for record in files:
        file = Path(record['path'])
        try:
            data = file.read_bytes()
            if not data or file.suffix.lower() in {'.part', '.tmp', '.crdownload'}:
                raise ValueError('Empty or unfinished download')
            if record.get('sha256') and hashlib.sha256(data).hexdigest() != record['sha256']:
                raise ValueError('Download checksum changed')
            suffix = file.suffix.lower()
            if record.get('kind') in {'structure', 'alignment_fasta', 'tree'}:
                validate_content(record['kind'], data, aligned=record['kind'] == 'alignment_fasta')
            elif suffix in {'.pdb', '.cif'}:
                validate_content('structure', data)
            elif suffix in {'.nwk', '.treefile', '.contree'}:
                validate_content('tree', data)
            elif suffix in {'.fa', '.fasta', '.pir'}:
                fasta_records(data.decode('utf-8-sig'))
            elif suffix in {'.xml', '.svg'}:
                root = ElementTree.fromstring(data)
                if suffix == '.svg' and not root.tag.endswith('svg'):
                    raise ValueError('Expected SVG content')
                if root.tag.lower() in {'html', 'error'}:
                    raise ValueError('Service error is not a result download')
            elif suffix == '.json':
                payload = json.loads(data)
                if isinstance(payload, dict) and payload.get('error'):
                    raise ValueError('Service error is not a scientific result')
            elif suffix in {'.zip', '.docx'}:
                with zipfile.ZipFile(file) as bundle:
                    if not bundle.namelist() or bundle.testzip():
                        raise ValueError('Archive is empty or has a corrupt member')
                    if suffix == '.docx':
                        ElementTree.fromstring(bundle.read('word/document.xml'))
            elif suffix == '.pdf':
                if not data.startswith(b'%PDF-') or b'%%EOF' not in data[-2048:]:
                    raise ValueError('Truncated or invalid PDF')
            elif suffix in {'.png', '.gif', '.jpg', '.jpeg', '.webp'}:
                from PIL import Image
                with Image.open(file) as image:
                    image.verify()
            elif suffix in {'.ps', '.eps'}:
                if not data.startswith(b'%!PS'):
                    raise ValueError('Expected PostScript content')
            else:
                prefix = data[:4096].decode('utf-8', errors='ignore')
                if re.search(r'^\s*(?:<!doctype\s+html|<html|(?:error\s*)?(?:404|500|502|503)\b)', prefix, re.I):
                    raise ValueError('HTML or service error saved as a data file')
            checked.append({'path': str(file), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        except Exception as error:
            issues.append(file.name + ': ' + str(error)[:250])
    return {'status': 'partial' if issues else 'complete' if checked else 'not_applicable', 'files': checked, 'issues': issues}


class DownloadTracker:
    def __init__(self, frames, hosts, previous=None, context=None, directory=None):
        self.frames, self.hosts = set(frames), set(hosts)
        self.records = {row["guid"]: dict(row) for row in (previous or []) if row.get("guid")}
        self.lock, self.ready, self.stop_event = threading.Lock(), threading.Event(), threading.Event()
        self.available = False
        self.context, self.directory = context, directory
        self.thread = threading.Thread(target=self._thread, daemon=True)
        self.thread.start()
        self.ready.wait(3)

    def started(self, event, _session=None):
        if event.get("frameId") not in self.frames or urlparse(event.get("url", "")).hostname not in self.hosts:
            return
        with self.lock:
            self.records[event["guid"]] = {"guid": event["guid"], "url": event.get("url"), "name": event.get("suggestedFilename"), "state": "inProgress"}

    def progress(self, event, _session=None):
        with self.lock:
            row = self.records.get(event.get("guid"))
            if row is not None:
                row.update({key: event[key] for key in ("state", "receivedBytes", "totalBytes") if key in event})

    def snapshot(self):
        with self.lock:
            return [dict(row) for row in self.records.values()]

    def _thread(self):
        try:
            asyncio.run(self._watch())
        except Exception:
            self.ready.set()

    async def _watch(self):
        from browser_harness.daemon import get_ws_url
        from cdp_use.client import CDPClient
        client = CDPClient(get_ws_url())
        try:
            await asyncio.wait_for(client.start(), 2)
            client.register.Browser.downloadWillBegin(self.started)
            client.register.Browser.downloadProgress(self.progress)
            if self.context and self.directory:
                await client.send_raw("Browser.setDownloadBehavior", {"behavior": "allow", "browserContextId": self.context, "downloadPath": self.directory, "eventsEnabled": True})
            self.available = True
            self.ready.set()
            while not self.stop_event.is_set():
                await asyncio.sleep(0.1)
        finally:
            await client.stop()

    def close(self):
        self.stop_event.set()
        self.thread.join(timeout=1)
