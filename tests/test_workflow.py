from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from workflow.artifacts import validate_content, descriptor, scoped
from workflow.site import verify_result, parameter_verified, resolve_exact_value, task_download_directory, alignment_matches_input


class ArtifactTests(unittest.TestCase):
    def test_download_survives_attempt_and_controller_restart(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            legacy = root / 'nodes/mafft/attempt-1/downloads.tmp'
            legacy.mkdir(parents=True)
            (legacy / 'alignment.aln-fasta').write_text('>a\nMKL\n>b\nM-L\n')
            checkpoint = {}
            self.assertEqual(task_download_directory(root, 'mafft', checkpoint), legacy)
            self.assertEqual(task_download_directory(root, 'mafft', dict(checkpoint)), legacy)
            with self.assertRaisesRegex(ValueError, 'another node'):
                task_download_directory(root, 'other', checkpoint)

    def test_alignment_must_contain_all_original_sequences(self):
        source = '>a\nMKL\n>b\nML\n'
        self.assertTrue(alignment_matches_input(b'>a\nMKL\n>b\nM-L\n', source))
        self.assertFalse(alignment_matches_input(b'>a\nMKL\n>b\nM-K\n', source))
        self.assertFalse(alignment_matches_input(b'>a\nMKL\n', source))

    def test_long_fasta_keeps_every_character(self):
        text = '>long\n' + 'ACDEFGHIKLMNPQRSTVWY' * 300 + '\n'
        result = validate_content('protein_fasta', text.encode())
        self.assertEqual(result['lengths'], [6000])

    def test_multiple_primary_records_rejected(self):
        with self.assertRaisesRegex(ValueError, 'one research object'):
            validate_content('protein_fasta', b'>a\nMKLL\n>b\nMKAA\n')

    def test_html_download_is_not_a_structure(self):
        with self.assertRaisesRegex(ValueError, 'HTML'):
            validate_content('structure', b'<html>Login required</html>')

    def test_misaligned_rows_and_broken_tree_rejected(self):
        with self.assertRaises(ValueError):
            validate_content('alignment_fasta', b'>a\nMKLL\n>b\nMKA\n', aligned=True)
        with self.assertRaises(ValueError):
            validate_content('tree', b'(a:1,b:2;')
        self.assertEqual(validate_content('tree', b'(a:1,b:2);')['format'], 'newick')

    def test_descriptor_checks_hash_and_scope(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            file = root / 'input.fasta'
            file.write_text('>p\nMKKLL\n')
            artifact = descriptor(root, file, 'protein_fasta', 'a')
            self.assertEqual(len(artifact['sha256']), 64)
            self.assertTrue(artifact['verified'])
            with self.assertRaises(ValueError):
                scoped(root, '../other')

    def test_corrupt_tree_and_nonfinite_structure_are_rejected(self):
        for tree in (b'(a,,b);', b'(a:NaN,b:1);', b'(a,b);junk', b'(a:bad,b:1);'):
            with self.assertRaises(ValueError):
                validate_content('tree', tree)
        self.assertEqual(validate_content('tree', b"('human one':0.1,mouse:0.2)99;")['leaves'], ['human one', 'mouse'])
        with self.assertRaises(ValueError):
            validate_content('structure', b'ATOM      1  N   MET A   1         NaN   1.000   2.000')
        with self.assertRaises(ValueError):
            validate_content('structure', b'loop_\n_atom_site.group_PDB\n_atom_site.Cartn_x\n_atom_site.Cartn_y\n_atom_site.Cartn_z\nATOM 1.0 2.0\n')


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.recipe = {'allowedHosts': ['example.org'], 'resultPatterns': ['Prediction results', 'Nucleus'], 'pendingPattern': 'job running'}
        self.page = {'url': 'https://example.org/result/123', 'text': 'Prediction results Nucleus'}
        self.checkpoint = {'inputVerified': True, 'submitted': True}

    def test_model_done_is_not_proof(self):
        self.page['text'] = 'DONE'
        self.assertFalse(verify_result(self.recipe, self.page, self.checkpoint, '')[0])

    def test_original_input_and_official_host_required(self):
        self.assertTrue(verify_result(self.recipe, self.page, self.checkpoint, '')[0])
        self.assertFalse(verify_result(self.recipe, self.page, {}, '')[0])
        self.page['url'] = 'https://impostor.example/result/123'
        self.assertFalse(verify_result(self.recipe, self.page, self.checkpoint, '')[0])

    def test_pending_and_custom_never_succeed(self):
        self.page['text'] += ' job running'
        self.assertFalse(verify_result(self.recipe, self.page, self.checkpoint, '')[0])
        self.recipe['experimental'] = True
        self.assertFalse(verify_result(self.recipe, self.page, self.checkpoint, '')[0])

    def test_accession_must_match_exactly(self):
        self.recipe['lookup'] = True
        self.page['text'] += ' P69905'
        self.assertTrue(verify_result(self.recipe, self.page, self.checkpoint, 'P69905')[0])
        self.assertFalse(verify_result(self.recipe, self.page, self.checkpoint, 'P6990')[0])

    def test_interpro_completed_list_is_not_annotation(self):
        self.recipe.update(id='interpro', resultPatterns=['InterProScan', 'Completed'])
        self.page['text'] = 'Your InterProScan Results protein.fasta Completed'
        self.assertFalse(verify_result(self.recipe, self.page, self.checkpoint, '')[0])

    def test_uniprot_help_cannot_pass_as_blast_hits(self):
        self.recipe.update(id='uniprot',resultPatterns=['BLAST results','Identity'])
        self.page.update(url='https://example.org/blast',text='Help: BLAST results Identity E-value Score',tables=[[['Option','Description'],['E-value','How to interpret results']]])
        self.assertFalse(verify_result(self.recipe,self.page,self.checkpoint,'')[0])
        self.page.update(url='https://example.org/blast/job-123',tables=[[['Entry','Identity','Score','E-value'],['P69905','100%','288','1e-100']]])
        self.assertTrue(verify_result(self.recipe,self.page,self.checkpoint,'')[0])

    def test_itol_must_render_exact_bound_tree_leaves(self):
        self.recipe.update(id='itol_web')
        self.page.update(url='https://example.org/tree/123', tree={'rendered': True, 'nodeCount': 3, 'leaves': ['human', 'mouse']})
        self.assertTrue(verify_result(self.recipe, self.page, self.checkpoint, '(human:1,mouse:2);')[0])
        self.assertFalse(verify_result(self.recipe, self.page, self.checkpoint, '(human:1,rat:2);')[0])

    def test_parameter_requires_correct_active_control(self):
        parameter = {'aliases': {'Slow': ['slow-sequential']}, 'fieldPattern': '^mode$'}
        self.assertFalse(parameter_verified(parameter, 'Slow', [{'label':'mode','value':'slow-sequential','active':False}]))
        self.assertTrue(parameter_verified(parameter, 'Slow', [{'label':'mode','value':'slow-sequential','active':True}]))
        checkbox = {'checkbox':True,'fieldPattern':'^noprofile$'}
        self.assertFalse(parameter_verified(checkbox,'false',[{'label':'skip','type':'checkbox','checked':False}]))
        self.assertTrue(parameter_verified(checkbox,'false',[{'label':'noprofile','type':'checkbox','checked':False}]))

    def test_format_parameter_never_replaces_fasta_sequence(self):
        recipe = {'input':'protein_fasta','inputPattern':'sequence|fasta','parameters':[{'id':'format','label':'输出格式 / Output format'}]}
        action = {'kind':'fill','role':'textbox','label':'Paste your protein sequence here in FASTA format:'}
        self.assertEqual(resolve_exact_value(action, {'actions':[action]}, recipe, {'format':'Long'}, '>p\nMKKL\n', Path('protein.fasta')), '>p\nMKKL\n')
        action = {**action,'label':'Output format'}
        self.assertEqual(resolve_exact_value(action, {'actions':[action]}, recipe, {'format':'Long'}, '>p\nMKKL\n', Path('protein.fasta')), 'Long')


if __name__ == '__main__':
    unittest.main()
