"""Run with the browser Python: bounded provider failures never become actions."""
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
try:
    import httpx
except ImportError:
    raise unittest.SkipTest('Run this module with the configured browser Python (httpx required)')
from vendor.jev_ultrafast import model


class ProviderBoundaryTests(unittest.TestCase):
    def response(self, status, payload=None):
        return httpx.Response(status, json=payload or {}, request=httpx.Request('POST','https://example.test/model'))

    def test_rate_limit_backoff_is_bounded(self):
        with patch.object(model.CLIENT,'post',side_effect=[self.response(429),self.response(503),self.response(200,{'ok':True})]) as post, patch.object(model.time,'sleep') as sleep:
            self.assertEqual(model.post_json('https://example.test/model','private-key',{}),{'ok':True})
            self.assertEqual(post.call_count,3)
            self.assertEqual([c.args[0] for c in sleep.call_args_list],[0.5,1.0])

    def test_exhausted_rate_limit_never_returns_a_decision(self):
        with patch.object(model.CLIENT,'post',return_value=self.response(429,{'secret':'private-key'})) as post, patch.object(model.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'HTTP 429; no action executed') as error:
                model.post_json('https://example.test/model','private-key',{})
            self.assertEqual(post.call_count,3)
            self.assertNotIn('private-key',str(error.exception))

    def test_nontransient_provider_error_is_not_retried(self):
        with patch.object(model.CLIENT,'post',return_value=self.response(400,{'error':'private-provider-response'})) as post:
            with self.assertRaises(RuntimeError) as error:
                model.post_json('https://example.test/model','key',{})
            self.assertEqual(post.call_count,1)
            self.assertNotIn('private-provider-response',str(error.exception))

    def test_network_failure_does_not_leak_credentials(self):
        with patch.object(model.CLIENT,'post',side_effect=httpx.ConnectError('private-key')):
            with self.assertRaisesRegex(RuntimeError,'Model connection failed; no action executed') as error:
                model.post_json('https://example.test/model','private-key',{})
            self.assertNotIn('private-key',str(error.exception))

    def test_invalid_or_nonfinite_choices_are_rejected(self):
        for answer in ({'choice':'C','probabilities':{'A':1,'B':0}}, {'choice':'A','probabilities':{'A':float('nan'),'B':0}}, {'choice':'A','probabilities':{'A':0.2,'B':0.8}}):
            with self.assertRaises(ValueError):
                model.validate_choice(answer,{'A','B'})


if __name__=='__main__': unittest.main()
