import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from upload_recovery import recover_upload_state, file_identity
from pipeline_failure import PipelineFailure
import upload_to_youtube as pipeline


class UploadRecoveryTests(unittest.TestCase):
    def setUp(self):
        sleeper = patch('upload_recovery.time.sleep')
        sleeper.start()
        self.addCleanup(sleeper.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.video = self.root / 'video.mp4'
        self.video.write_bytes(b'video-content')
        self.current = file_identity(self.video)

    def http(self, status, content=b''):
        return SimpleNamespace(request=lambda *a, **kw: (SimpleNamespace(status=status), content))

    def saved(self, **values):
        return {**self.current, 'uri': 'https://www.googleapis.com/upload/session', **values}

    def test_expired_session_rebuilds_and_does_not_mutate_current_identity(self):
        result = recover_upload_state(self.saved(), self.current, self.http(404))
        self.assertNotIn('uri', result)
        result['uri'] = 'new'
        self.assertNotIn('uri', self.current)

    def test_identical_regenerated_file_resumes_despite_changed_mtime_and_path(self):
        result = recover_upload_state(self.saved(file='old.mp4', mtime=1), self.current, self.http(308))
        self.assertIn('uri', result)
        self.assertEqual(result['mtime'], self.current['mtime'])

    def test_changed_content_restarts_only_after_server_confirms_incomplete(self):
        result = recover_upload_state(self.saved(sha256='old-hash'), self.current, self.http(308))
        self.assertNotIn('uri', result)

    def test_completed_upload_reuses_server_video_even_if_local_file_changed(self):
        result = recover_upload_state(self.saved(sha256='old-hash'), self.current, self.http(200, b'{"id":"existing-video"}'))
        self.assertEqual(result['video_id'], 'existing-video')

    def test_missing_session_uri_before_media_send_can_be_recreated(self):
        result = recover_upload_state(dict(self.current), self.current, self.http(500))
        self.assertEqual(result, self.current)

    def test_unknown_completion_and_query_failures_never_start_new_upload(self):
        cases = [(self.saved(completion_pending=True), self.http(404)),
                 (self.saved(), self.http(500)), (self.saved(), self.http(401)),
                 (self.saved(), self.http(200, b'{}')),
                 ({**self.current, 'bytes_attempted': True}, self.http(404))]
        for saved, http in cases:
            with self.subTest(saved=saved):
                with self.assertRaises(PipelineFailure):
                    recover_upload_state(saved, self.current, http)

    def test_real_sdk_expired_session_restarts_and_completed_session_does_not_reupload(self):
        from googleapiclient.http import HttpRequest
        from httplib2 import Response
        for complete in (False, True):
            with self.subTest(complete=complete):
                checkpoint = self.root / f'session-{complete}.json'
                checkpoint.write_text(json.dumps(self.saved()), encoding='utf-8')
                calls = []
                responses = ([(200, {}, b'{"id":"already-uploaded"}')] if complete else [
                    (308, {}, b''), (404, {}, b''), (404, {}, b''),
                    (200, {'location': 'https://www.googleapis.com/upload/new-session'}, b''),
                    (200, {}, b'{"id":"new-video"}')])
                def send(uri, method='GET', body=None, headers=None, **kwargs):
                    calls.append((uri, method, dict(headers or {})))
                    code, extra, content = responses.pop(0)
                    return Response({'status': str(code), **extra}), content
                http = SimpleNamespace(request=send)
                def insert(**kwargs):
                    return HttpRequest(http, lambda response, content: json.loads(content),
                        'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable',
                        method='POST', body=json.dumps(kwargs['body']),
                        headers={'content-type':'application/json'}, resumable=kwargs['media_body'])
                youtube = SimpleNamespace(videos=lambda: SimpleNamespace(insert=insert))
                result = pipeline.upload_video(youtube, self.video, 'title', '', [], 'private', checkpoint_path=checkpoint)
                self.assertEqual(result[0], 'already-uploaded' if complete else 'new-video')
                self.assertEqual(sum(method == 'POST' for _, method, _ in calls), 0 if complete else 1)
                self.assertEqual(json.loads(checkpoint.read_text())['video_id'], result[0])
                self.assertEqual(responses, [])

    def test_final_chunk_pending_is_saved_before_network_and_retained_on_lost_response(self):
        checkpoint = self.root / 'pending.json'
        state = self.saved()
        def send(*args, **kwargs):
            self.assertTrue(json.loads(checkpoint.read_text())['completion_pending'])
            raise OSError('connection reset')
        transport = pipeline._UploadCheckpointTransport(SimpleNamespace(request=send), checkpoint, state)
        with self.assertRaises(OSError):
            transport.request(state['uri'], 'PUT', headers={'Content-Range':'bytes 0-12/13'})
        self.assertTrue(state['completion_pending'])

    def test_temporary_query_errors_retry_without_creating_another_session(self):
        responses = iter([503, 429, 308])
        calls = []
        def send(*args, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(status=next(responses)), b''
        state = recover_upload_state(self.saved(), self.current, SimpleNamespace(request=send))
        self.assertIn('uri', state)
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(c['body'] == b'' for c in calls))


if __name__ == '__main__':
    unittest.main()
