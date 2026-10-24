import hashlib
import os
from unittest.mock import patch
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from workflow.delivery import open_pages
from workflow.input_check import compare_input


class FakeChrome:
    def __init__(self):
        self.contexts, self.targets, self.created, self.calls = [], {}, 0, []

    def __call__(self, method, **args):
        self.calls.append((method, args))
        if method == 'Target.getTargets': return {'targetInfos': list(self.targets.values())}
        if method == 'Target.getBrowserContexts': return {'browserContextIds': self.contexts}
        if method == 'Target.createBrowserContext':
            context = 'context-' + str(len(self.contexts)); self.contexts.append(context)
            return {'browserContextId': context}
        if method == 'Target.createTarget':
            self.created += 1; target = str(self.created)
            self.targets[target] = {'targetId': target, 'browserContextId': args['browserContextId'], 'url': args['url']}
            return {'targetId': target}
        if method == 'Target.attachToTarget': return {'sessionId': args['targetId']}
        if method == 'Page.navigate': self.targets[args['session_id']]['url'] = args['url']
        if method == 'Runtime.evaluate': return {'result': {'value': {'url': self.targets[args['session_id']]['url'], 'ready': 'complete', 'text': 40}}}
        if method == 'Browser.getWindowForTarget': return {'windowId': 42}
        return {}


class DeliveryTests(unittest.TestCase):
    def test_single_window_idempotency_close_and_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            chrome = FakeChrome(); pages = []
            for number in range(3):
                file = Path(folder) / f'{number}.html'; file.write_text('<html>Original result</html>')
                pages.append({'path': str(file), 'key': file.name, 'itemId': str(number), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()})
            first = open_pages(pages, cdp=chrome)
            self.assertEqual(first['opened'], 3)
            self.assertEqual({p['windowId'] for p in first['pages']}, {42})
            again = open_pages(pages, first['state'], cdp=chrome)
            self.assertEqual(chrome.created, 3)
            del chrome.targets['2']
            restored = open_pages(pages, again['state'], cdp=chrome)
            self.assertEqual(chrome.created, 4); self.assertEqual(restored['opened'], 3)
            chrome.targets.clear(); chrome.contexts.clear()
            restarted = open_pages(pages, restored['state'], cdp=chrome)
            self.assertEqual(restarted['opened'], 3)
            self.assertTrue(any(m == 'Emulation.setScriptExecutionDisabled' for m, _ in chrome.calls))
            self.assertFalse(any(m.startswith('Input.') for m, _ in chrome.calls))

    def test_explicit_chrome_endpoint_overrides_stale_websocket_and_scopes_daemon(self):
        from workflow_worker import configure
        with patch.dict(os.environ, {'BU_CDP_WS': 'ws://old-browser', 'BU_CDP_URL': 'http://old-browser'}):
            configure({'chromeUrl': 'http://127.0.0.1:9222'})
            self.assertNotIn('BU_CDP_WS', os.environ)
            first = os.environ['BU_NAME']
            configure({'chromeUrl': 'http://127.0.0.1:9222'})
            self.assertEqual(os.environ['BU_NAME'], first)
            configure({'chromeUrl': 'http://127.0.0.1:9333'})
            self.assertNotEqual(os.environ['BU_NAME'], first)

    def test_remote_http_errors_are_not_executor_failures(self):
        from workflow.site import check_service_error, RemoteServiceError
        with self.assertRaises(RemoteServiceError):
            check_service_error({'text': '502 Bad Gateway'})
        check_service_error({'text': 'Original scientific result: score 502'})

    def test_changed_file_reports_failure_and_opens_nothing(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'page.html'; file.write_text('changed')
            result = open_pages([{'path': str(file), 'key': 'page', 'itemId': 'a', 'sha256': 'bad'}], cdp=FakeChrome())
            self.assertEqual(result['opened'], 0); self.assertEqual(len(result['failed']), 1)

    def test_input_diagnostics_only_normalize_line_endings_and_final_newline(self):
        self.assertIsNone(compare_input('>s\r\nMPEPTIDE\r\n', '>s\nMPEPTIDE'))
        difference = compare_input('>s\nMPEPTIDE\n', '>s\nMPEP', {'label': 'Query sequence', 'node': 7})
        self.assertEqual(difference['expectedSequenceLength'], 8)
        self.assertEqual(difference['actualSequenceLength'], 4)
        self.assertEqual(difference['field']['label'], 'Query sequence')
        self.assertIsNotNone(compare_input('>s\nMPEPTIDE', '>s\nMPEP TIDE'))


if __name__ == '__main__': unittest.main()
