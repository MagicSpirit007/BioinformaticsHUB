import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from workflow.receipts import prepare_submission, observed_receipt, needs_reconciliation
from workflow.analysis_verifiers import verify_analysis


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.recipe = {'id': 'blastp', 'entryUrl': 'https://blast.ncbi.nlm.nih.gov/Blast.cgi', 'allowedHosts': ['blast.ncbi.nlm.nih.gov']}
        self.checkpoint = {'inputSha256': 'input-hash'}

    def test_intent_records_input_parameters_and_unique_attempt_before_click(self):
        args = (self.checkpoint, {'id': 'n', 'parameters': {'expect': '1e-5'}}, self.recipe, {'label': 'Submit'}, {'url': self.recipe['entryUrl'], 'text': 'Form'})
        first, second = prepare_submission(*args), prepare_submission(*args)
        self.assertTrue(first['effectPending'])
        self.assertEqual(first['submission']['inputSha256'], 'input-hash')
        self.assertNotEqual(first['submission']['attemptId'], second['submission']['attemptId'])
        with self.assertRaisesRegex(ValueError, 'reconciled'):
            prepare_submission({**self.checkpoint, **first}, *args[1:])

    def test_returned_click_and_loading_page_are_not_receipts(self):
        self.assertEqual(observed_receipt(self.recipe, {'url': self.recipe['entryUrl'], 'text': 'Loading'}, self.checkpoint), {})
        self.assertEqual(needs_reconciliation(self.checkpoint)['submission']['phase'], 'needs_reconciliation')

    def test_rid_survives_browser_loss_without_entry_url_replay(self):
        receipt = observed_receipt(self.recipe, {'url': self.recipe['entryUrl'], 'text': 'RID = ABC123456789'}, self.checkpoint)
        self.assertFalse(receipt['effectPending'])
        self.assertIn('CMD=Get&RID=ABC123456789', receipt['resultUrl'])
        self.assertEqual(receipt['submission']['phase'], 'receipt_known')
        self.assertEqual(observed_receipt(self.recipe, {'url': 'https://evil.test/', 'text': 'RID = ABC123456789'}, self.checkpoint), {})

    def test_post_only_results_never_masquerade_as_recoverable_get(self):
        receipt = observed_receipt(self.recipe, {'url': self.recipe['entryUrl'], 'text': 'Completed'}, self.checkpoint, results_ready=True)
        self.assertTrue(receipt['submitted'])
        self.assertIsNone(receipt['resultUrl'])


class ImportedAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = b'>query\nMSTK\n'
        self.input = self.root / 'input.fa'; self.input.write_bytes(self.data)

    def verify(self, executor, contents, suffix, **options):
        result = self.root / ('official' + suffix)
        result.write_bytes(contents if isinstance(contents, bytes) else contents.encode())
        return verify_analysis({'executor': executor, 'input': {'path': str(self.input), 'sha256': hashlib.sha256(self.data).hexdigest()}, 'files': [{'path': str(result), 'sha256': hashlib.sha256(result.read_bytes()).hexdigest()}], **options})

    def test_interpro_rejects_another_equal_length_sequence(self):
        def payload(seq):
            return json.dumps({'results': [{'sequence': seq, 'md5': hashlib.md5(seq.encode()).hexdigest(), 'matches': []}]})
        self.assertEqual(self.verify('interpro', payload('MSTK'), '.json')['status'], 'verified')
        self.assertEqual(self.verify('interpro', payload('MATK'), '.json')['status'], 'unverified')

    def test_interpro_checks_domain_bounds_and_md5(self):
        payload = {'results': [{'sequence': 'MSTK', 'md5': hashlib.md5(b'MSTK').hexdigest(), 'matches': [{'signature': {'accession': 'PF1'}, 'locations': [{'start': 1, 'end': 5}]}]}]}
        self.assertEqual(self.verify('interpro', json.dumps(payload), '.json')['status'], 'unverified')

    def test_blast_requires_full_residue_identity_and_database(self):
        xml = '<BlastOutput><BlastOutput_program>blastp</BlastOutput_program><BlastOutput_query-def>query</BlastOutput_query-def><BlastOutput_query-len>4</BlastOutput_query-len><BlastOutput_db>clustered_nr</BlastOutput_db><Hsp><Hsp_query-from>1</Hsp_query-from><Hsp_query-to>4</Hsp_query-to><Hsp_qseq>MSTK</Hsp_qseq><Hsp_evalue>0.01</Hsp_evalue></Hsp></BlastOutput>'
        options = {'parameters': {'database': 'ClusteredNR'}}
        self.assertEqual(self.verify('blastp', xml, '.xml', **options)['status'], 'verified')
        self.assertEqual(self.verify('blastp', xml.replace('MSTK', 'MATK'), '.xml', **options)['status'], 'unverified')
        self.assertEqual(self.verify('blastp', xml.replace('<Hsp_query-to>4', '<Hsp_query-to>3').replace('MSTK', 'MST'), '.xml', **options)['status'], 'unverified')

    def test_unknown_executor_never_accepts_caller_assertions(self):
        self.assertEqual(self.verify('unknown', '{"verified":true}', '.json')['status'], 'unverified')


if __name__ == '__main__':
    unittest.main()
