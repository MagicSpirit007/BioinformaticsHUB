import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from workflow.site import resolve_exact_value, email_form_issue, parameter_verified

class EmailNotificationTests(unittest.TestCase):
    def test_declined_and_unconfigured_email_cannot_be_autofilled(self):
        field = {'label': 'Email (optional)', 'type': 'email', 'value': 'old@example.org'}
        self.assertIsNotNone(email_form_issue([field], {}, {'choice': 'decline'}))
        self.assertIsNotNone(email_form_issue([field], {}, {}))
        self.assertIsNone(email_form_issue([{**field, 'value': ''}], {}, {'choice': 'decline'}))
        self.assertEqual(resolve_exact_value({'kind':'fill','label':'Email (optional)'},{'actions':[]},{}, {}, 'MPEPTIDE', Path('input')), '')
    def test_confirmed_email_is_exact_and_storage_checkbox_is_not_an_address(self):
        field = {'label': 'Email', 'type': 'email', 'value': 'chosen@example.org'}
        checkbox = {'label': 'I agree that my email address is stored', 'type': 'checkbox', 'value': 'on', 'checked': True}
        self.assertIsNone(email_form_issue([field, checkbox], {'email':'chosen@example.org'}, {'choice':'send'}))
        self.assertIsNotNone(email_form_issue([field], {'email':'different@example.org'}, {'choice':'send'}))

    def test_multiple_email_fields_and_aliases_reject_unconfirmed_autofill(self):
        for label in ['Email', 'E-mail address', '通知邮箱']:
            with self.subTest(label=label):
                good = {'label': label, 'type': 'email', 'value': 'chosen@example.org'}
                bad = {**good, 'value': 'autofilled@example.org'}
                self.assertIsNotNone(email_form_issue([good, bad], {'email': 'chosen@example.org'}, {'choice': 'send'}))
                self.assertIsNone(email_form_issue([good, good], {'email': 'chosen@example.org'}, {'choice': 'send'}))

    def test_missing_email_and_unchecked_storage_consent_fail_parameter_verification(self):
        email = {'id': 'email', 'fieldPattern': 'email|e-mail'}
        terms = {'id': 'emailConsent', 'checkbox': True, 'fieldPattern': 'I agree that my email address'}
        self.assertFalse(parameter_verified(email, 'chosen@example.org', [{'label': 'Email', 'type': 'email', 'value': ''}]))
        self.assertTrue(parameter_verified(email, 'chosen@example.org', [{'label': 'Email', 'type': 'email', 'value': 'chosen@example.org'}]))
        for checked in [False, True]:
            self.assertEqual(parameter_verified(terms, 'true', [{'label': 'I agree that my email address is stored', 'type': 'checkbox', 'checked': checked}]), checked)

if __name__ == '__main__': unittest.main()
