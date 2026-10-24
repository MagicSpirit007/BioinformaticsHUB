import base64
import gzip
import json
import struct
import sys
import tempfile
import unittest
from email.message import EmailMessage
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from workflow.resolver import resolve_sequence, GIGADB, SourceError
from workflow.archive import materialize_mhtml, capture_pngs
from workflow.downloads import DownloadTracker


class SequenceResolutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cache = self.temp.name
        self.library = gzip.compress(b'>CCA0737S0090\nMAEDFF\n>CCA0737S0092\nMKLLLL\n>CCA0737S0009\nMKKLLL\n')

    def test_cca_prefix_does_not_select_a_species_or_reference_library(self):
        empty = json.dumps({'esearchresult': {'idlist': [], 'count': '0'}}).encode()
        with patch('workflow.resolver.fetch', return_value=empty) as download:
            result = resolve_sequence({'identifier': 'CCA0737S009'}, self.cache)
        self.assertEqual(result['status'], 'not_found')
        self.assertEqual(result['actionRequired'], 'discover_source')
        self.assertNotIn('fasta', result)
        self.assertEqual(result['candidates'], [])
        self.assertEqual(download.call_count, 1)
        searched_url = download.call_args.args[0]
        self.assertNotIn(GIGADB, searched_url)
        self.assertNotIn('Organism', searched_url)
        self.assertNotIn('Carya', searched_url)
        self.assertEqual(result['searched'], [searched_url])

    def test_cca_record_species_comes_from_the_retrieved_record(self):
        search = {'esearchresult': {'idlist': ['42'], 'count': '1'}}
        summary = {'result': {'42': {'accessionversion': 'CCA0737S009', 'taxid': 4530}}}
        fasta = b'>CCA0737S009 protein [Oryza sativa]\nMKKLLL\n'
        with patch('workflow.resolver.fetch', side_effect=[json.dumps(search).encode(), json.dumps(summary).encode(), fasta]):
            result = resolve_sequence({'identifier': 'CCA0737S009'}, self.cache)
        self.assertEqual(result['status'], 'resolved')
        self.assertEqual(result['provenance']['species'], 'Oryza sativa')
        self.assertEqual(result['provenance']['provider'], 'ncbi')

    def test_explicit_library_missing_digit_returns_candidates_without_sequence(self):
        with patch('workflow.resolver.fetch', return_value=self.library):
            result = resolve_sequence({'identifier': 'CCA0737S009', 'provider': 'gigadb'}, self.cache)
        self.assertEqual(result['status'], 'ambiguous')
        self.assertNotIn('fasta', result)
        self.assertIn('CCA0737S0090', [c['identifier'] for c in result['candidates']])

    def test_exact_record_is_cached_with_provenance(self):
        with patch('workflow.resolver.fetch', return_value=self.library) as download:
            first = resolve_sequence({'identifier': 'CCA0737S0090', 'provider': 'gigadb'}, self.cache)
            second = resolve_sequence({'identifier': 'CCA0737S0092', 'provider': 'gigadb'}, self.cache)
        self.assertEqual(first['fasta'], '>CCA0737S0090\nMAEDFF\n')
        self.assertTrue(second['cached'])
        self.assertEqual(download.call_count, 1)
        self.assertEqual(first['provenance']['species'], 'Carya cathayensis')
        self.assertEqual(len(first['provenance']['sourceSha256']), 64)

    def test_cached_library_does_not_become_an_implicit_source(self):
        with patch('workflow.resolver.fetch', return_value=self.library):
            resolve_sequence({'identifier': 'CCA0737S0090', 'provider': 'gigadb'}, self.cache)
        empty = json.dumps({'esearchresult': {'idlist': [], 'count': '0'}}).encode()
        with patch('workflow.resolver.fetch', return_value=empty):
            result = resolve_sequence({'identifier': 'CCA0737S0090'}, self.cache)
        self.assertEqual(result['status'], 'not_found')
        self.assertNotIn('fasta', result)
        self.assertFalse(any(url.startswith(GIGADB) for url in result['searched']))

    def test_wrong_species_is_not_silently_accepted(self):
        with patch('workflow.resolver.fetch', return_value=self.library):
            result = resolve_sequence({'identifier': 'CCA0737S0090', 'provider': 'gigadb', 'species': '拟南芥'}, self.cache)
        self.assertEqual(result['actionRequired'], 'confirm_species')
        self.assertNotIn('fasta', result)

    def test_network_failure_is_not_not_found(self):
        with patch('workflow.resolver.fetch', side_effect=SourceError('Source connection failed')):
            result = resolve_sequence({'identifier': 'CCA0737S0090', 'provider': 'gigadb'}, self.cache)
        self.assertEqual(result['status'], 'error')
        self.assertEqual(result['code'], 'SOURCE_UNAVAILABLE')

    def test_uniprot_multiple_records_require_selection(self):
        body = json.dumps({'results': [{'primaryAccession': x, 'organism': {'scientificName': 'Arabidopsis thaliana'}} for x in ['P12345', 'P12346']]}).encode()
        with patch('workflow.resolver.fetch', return_value=body):
            result = resolve_sequence({'identifier': 'GENE', 'provider': 'uniprot'}, self.cache)
        self.assertEqual(result['status'], 'ambiguous')
        self.assertNotIn('fasta', result)

    def test_custom_library_requires_exact_id(self):
        with patch('workflow.resolver.fetch', return_value=b'>foo\nMKK\n'):
            result = resolve_sequence({'identifier': 'foo', 'sourceUrl': 'https://example.org/proteins.fa'}, self.cache)
        self.assertEqual(result['identifier'], 'foo')
        self.assertEqual(result['provenance']['provider'], 'custom')

    def test_numeric_gene_id_is_not_mistaken_for_a_protein_uid(self):
        with patch('workflow.resolver.fetch') as download:
            result = resolve_sequence({'identifier': '2335'}, self.cache)
        self.assertEqual(result['actionRequired'], 'confirm_identifier_namespace')
        self.assertNotIn('fasta', result)
        download.assert_not_called()


class ArchiveTests(unittest.TestCase):
    def make_archive(self, missing=False):
        message = EmailMessage()
        message.set_type('multipart/related')
        page = EmailMessage()
        page.set_content('<html><head><link rel="stylesheet" href="/style.css"></head><body><h1>Original result</h1><img src="/plot.png"><script>fetch("/rerun")</script></body></html>', subtype='html')
        page['Content-Location'] = 'https://example.org/result/123'
        message.attach(page)
        css = EmailMessage()
        css.set_content('body {color: black; background:url("/plot.png")}', subtype='css'); css['Content-Location'] = 'https://example.org/style.css'; message.attach(css)
        if not missing:
            image = EmailMessage()
            image.set_content(b'original-image', maintype='image', subtype='png'); image['Content-Location'] = 'https://example.org/plot.png'; message.attach(image)
        return message.as_bytes()

    def test_html_preserves_result_and_rewrites_local_resources(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            result = materialize_mhtml(self.make_archive(), root, 'https://example.org/result/123')
            page = (root / 'page.html').read_text()
            self.assertTrue(result['offlineReadable'])
            self.assertIn('Original result', page)
            self.assertIn('assets/', page)
            self.assertNotIn('<script', page)
            self.assertEqual(len(list((root / 'assets').iterdir())), 2)

    def test_missing_resources_are_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            result = materialize_mhtml(self.make_archive(True), Path(temp), 'https://example.org/result/123')
        self.assertFalse(result['offlineReadable'])
        self.assertIn('https://example.org/plot.png', result['missingResources'])

    def test_two_times_capture_tiles_without_downscaling_and_restores_metrics(self):
        class Browser:
            scale = 1
            def evaluate(self, _): return {'width': 1280, 'height': 900, 'scale': 1}
            def call(self, method, **args):
                if method == 'Page.getLayoutMetrics': return {'cssContentSize': {'width': 1280, 'height': 5000}}
                if method == 'Emulation.setDeviceMetricsOverride': self.scale = args['deviceScaleFactor']
                if method == 'Page.captureScreenshot':
                    clip = args['clip']; size = struct.pack('>II', round(clip['width'] * self.scale), round(clip['height'] * self.scale))
                    return {'data': base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'\x00' * 8 + size).decode()}
                return {}
        browser = Browser()
        with tempfile.TemporaryDirectory() as temp:
            images = capture_pngs(browser, Path(temp))
        self.assertEqual(len(images), 3)
        self.assertTrue(all(image['width'] == 2560 for image in images))
        self.assertEqual(sum(image['height'] for image in images), 10000)
        self.assertEqual(browser.scale, 1)

    def test_invalid_crop_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(ValueError): capture_pngs(None, Path(temp), clip={'x': 0, 'y': 0, 'width': 0, 'height': 2})

    def test_download_events_are_filtered_by_owned_frame_and_guid(self):
        tracker = DownloadTracker.__new__(DownloadTracker)
        import threading
        tracker.frames, tracker.hosts, tracker.records, tracker.lock = {'owned'}, {'example.org'}, {}, threading.Lock()
        tracker.started({'frameId': 'other', 'guid': 'wrong', 'url': 'https://example.org/file'})
        tracker.started({'frameId': 'owned', 'guid': 'right', 'url': 'https://example.org/file', 'suggestedFilename': 'tree.nwk'})
        tracker.progress({'guid': 'right', 'state': 'completed', 'receivedBytes': 42})
        self.assertEqual(tracker.snapshot(), [{'guid': 'right', 'url': 'https://example.org/file', 'name': 'tree.nwk', 'state': 'completed', 'receivedBytes': 42}])


if __name__ == '__main__': unittest.main()
