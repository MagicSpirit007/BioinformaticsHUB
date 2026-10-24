import hashlib
import sys
import tempfile
import unittest
from email.message import EmailMessage
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from workflow.archive import materialize_mhtml
from workflow.archive_validation import compare_baseline
from workflow.downloads import verify_files
from workflow.site import resolve_exact_value, verify_result


class IntegrityTests(unittest.TestCase):
    def test_sequence_binding_excludes_ncbi_subranges_but_keeps_parameters(self):
        recipe={'input':'protein_fasta','inputPattern':'query|sequence','parameters':[{'id':'organism','label':'Organism'}]}
        for name in ['QUERY_FROM','QUERY_TO','ENTREZ_QUERY']:
            action={'kind':'fill','label':name,'fieldName':name,'role':'textbox'}
            self.assertIsNone(resolve_exact_value(action,{'actions':[action]},recipe,{},'>x\nMPEPTIDE',Path('x')))
        action={'kind':'fill','label':'Organism','fieldName':'organism'}
        self.assertEqual(resolve_exact_value(action,{'actions':[action]},recipe,{'organism':'Carya cathayensis'},'MPEPTIDE',Path('x')),'Carya cathayensis')

    def test_interpro_example_ids_on_search_page_are_not_results(self):
        recipe={'id':'interpro','allowedHosts':['www.ebi.ac.uk'],'resultPatterns':['InterPro','Protein family']}
        evidence={'url':'https://www.ebi.ac.uk/interpro/search/text/','text':'InterPro Protein family Examples IPR020422 PF02932'}
        ok,reason=verify_result(recipe,evidence,{'inputVerified':True,'submitted':True},'>x\nMPEPTIDE')
        self.assertFalse(ok);self.assertIn('specific sequence-analysis job',reason)

    def test_blast_cpu_error_is_not_a_valid_no_hits_result(self):
        recipe={'id':'psi_blast','allowedHosts':['blast.ncbi.nlm.nih.gov'],'resultPatterns':['PSI-BLAST','No significant similarity']}
        evidence={'url':'https://blast.ncbi.nlm.nih.gov/Blast.cgi?RID=EXAMPLE','text':'PSI-BLAST Query Length 8 CPU usage limit was exceeded. No significant similarity found.'}
        ok,reason=verify_result(recipe,evidence,{'inputVerified':True,'submitted':True},'>x\nMPEPTIDE')
        self.assertFalse(ok);self.assertIn('error receipt',reason)

    def test_expasy_input_cannot_bind_accession_field(self):
        recipe={'entryUrl':'https://web.expasy.org/protparam/','input':'protein_fasta','inputPattern':'sequence|accession'}
        for name,expected in [('mandatory',None),('sequence','MPEPTIDE')]:
            action={'kind':'fill','label':'Sequence or accession','fieldName':name}
            self.assertEqual(resolve_exact_value(action,{'actions':[action]},recipe,{},'MPEPTIDE',Path('x')),expected)

    def test_fonts_missing_from_mhtml_are_embedded_and_styles_are_portable(self):
        archive = EmailMessage(); archive.make_mixed()
        for location, mime, content in [('https://site.test/result', 'html', '<html><head><link rel="stylesheet" href="/style.css"></head><body>Result 42</body></html>'),
                                        ('https://site.test/style.css', 'css', '@font-face{font-family:icons;src:url("/font.woff2?v=3")}')]:
            part = EmailMessage(); part.set_content(content, subtype=mime); part['Content-Location'] = location; archive.attach(part)
        with tempfile.TemporaryDirectory() as folder:
            result = materialize_mhtml(archive.as_bytes(), Path(folder), 'https://site.test/result', resources={
                'https://site.test/font.woff2?v=3': {'mime': 'font/woff2', 'data': b'fixture-font'}})
            self.assertEqual(result['embeddedFonts'], 1)
            self.assertEqual(result['missingResources'], [])
            css = next((Path(folder) / 'assets').glob('*.css')).read_text()
            self.assertIn('data:font/woff2;base64,', css)
            self.assertIn("form-action 'none'", (Path(folder) / 'page.html').read_text())

    def test_blank_or_restyled_result_does_not_pass_render_verification(self):
        baseline = {'text': 'Score 42', 'samples': [{'node': 1, 'width': 200, 'height': 100, 'fontFamily': 'icons', 'fontSize': '18px', 'color': 'blue'}]}
        actual = {'text': '', 'issues': [], 'nodes': {'1': {'width': 0, 'height': 0, 'fontFamily': 'serif', 'fontSize': '12px', 'color': 'black'}}}
        issues = compare_baseline(actual, baseline)
        self.assertTrue(any('blank' in x for x in issues))
        self.assertTrue(any('styling' in x for x in issues))

    def test_checksum_alone_does_not_validate_truncated_or_error_downloads(self):
        with tempfile.TemporaryDirectory() as folder:
            files = []
            for name, data in [('model.pdb', b'<html>502 Bad Gateway</html>'), ('plot.pdf', b'%PDF-1.7 truncated'), ('partial.crdownload', b'abc')]:
                file = Path(folder) / name; file.write_bytes(data)
                files.append({'path': str(file), 'sha256': hashlib.sha256(data).hexdigest()})
            checked = verify_files(files)
            self.assertEqual(checked['status'], 'partial')
            self.assertEqual(len(checked['issues']), 3)


if __name__ == '__main__': unittest.main()
