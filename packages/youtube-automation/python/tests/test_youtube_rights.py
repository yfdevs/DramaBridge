import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from pipeline_failure import PipelineFailure
import upload_to_youtube as pipeline
import web_service
from oauth_service import SCOPE, SCOPES, Authorization, test_authorization


class BrowserRightsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = web_service.Store(self.root / 'data')

    def task(self, **values):
        return self.store.create(dict(resourceName='test', shareText='https://pan.baidu.com/s/test', **values))

    def test_task_defaults_and_boolean_validation(self):
        self.assertFalse(self.task()['payload']['rightsManagement'])
        self.assertTrue(self.task(rightsManagement=True)['payload']['rightsManagement'])
        for value in ('true', 1, None):
            with self.assertRaises(ValueError):
                self.task(rightsManagement=value)

    def test_upload_only_credentials_never_initialize_partner_api(self):
        self.assertEqual(SCOPES, [SCOPE])
        token = self.root / 'token.json'
        token.write_text('{}')
        creds = MagicMock()
        creds.has_scopes.side_effect = lambda scopes: scopes == [SCOPE]
        with patch('google.oauth2.credentials.Credentials.from_authorized_user_file', return_value=creds), \
                patch('googleapiclient.discovery.build') as build:
            pipeline.get_authenticated_service(Path('secret.json'), token, allow_interactive=False)
            build.assert_called_once_with('youtube', 'v3', credentials=creds)

    def test_oauth_accepts_upload_only_permission(self):
        flow = MagicMock()
        flow.authorization_url.return_value = ('https://accounts.google.com/', 'state')
        flow.credentials.to_json.return_value = '{}'
        flow.credentials.granted_scopes = [SCOPE]
        saver = MagicMock()
        auth = Authorization(self.root, 12345, saver, lambda: '', flow_factory=lambda *_: flow)
        auth.start()
        auth.finish('state', 'code')
        saver.assert_called_once_with('token', {})

    def test_live_upload_permission_needs_no_cms(self):
        token = self.root / 'token.json'
        token.write_text(json.dumps(dict(client_id='client', client_secret='secret', refresh_token='refresh')))
        refresh, info = MagicMock(), MagicMock()
        refresh.status_code = info.status_code = 200
        refresh.json.return_value = {'access_token': 'test'}
        info.json.return_value = dict(scope=SCOPE, aud='client', expires_in=3600)
        with patch('requests.Session') as factory:
            factory.return_value.__enter__.return_value.post.side_effect = [refresh, info]
            self.assertEqual(test_authorization(token, '')['status'], 'valid')

    def test_upload_records_video_even_when_browser_step_later_fails(self):
        source = self.root / 'video.mp4'
        args = pipeline.parse_args([str(source), '--upload-log', str(self.root / 'uploaded.json')])
        youtube = MagicMock()
        with patch.object(pipeline, 'upload_video', return_value=('abcdefghijk', 'https://youtu.be/abcdefghijk')), \
                patch.object(pipeline, 'extract_thumbnail_frame'), patch.object(pipeline, 'set_thumbnail'):
            pipeline._upload_processed_video(youtube, source, source, source, 'title', args, self.root, self.root)
        youtube.dramabridge_rights.apply.assert_not_called()
        self.assertTrue(pipeline.is_uploaded(args.upload_log, pipeline.compute_input_hash(source)))

    def test_browser_failure_retries_existing_links_and_completed_items(self):
        task = self.task(rightsManagement=True)
        self.store.update(task['id'], status='processing', result={'videoUrls': [
            'https://youtu.be/abcdefghijk', 'https://youtu.be/lmnopqrstuv']})
        worker = web_service.Worker(self.store)
        with patch.object(worker, 'apply_browser_rights', side_effect=[None, RuntimeError('login expired')]) as apply:
            with self.assertRaises(PipelineFailure):
                worker.finish_browser_rights(task)
            self.assertEqual(apply.call_count, 2)
        self.assertEqual(self.store.get(task['id'])['result']['browserRightsVideoIds'], ['abcdefghijk'])
        with patch.object(worker, 'apply_browser_rights') as apply:
            worker.finish_browser_rights(task)
            apply.assert_called_once_with(task, 'lmnopqrstuv')

    def test_execute_only_runs_browser_after_upload_when_user_opted_in(self):
        source = self.root / 'input.mp4'
        source.write_bytes(b'video')
        for enabled in (False, True):
            with self.subTest(enabled=enabled):
                task = self.task(rightsManagement=enabled)
                self.store.update(task['id'], local_path=str(source))
                worker = web_service.Worker(self.store)
                events = []
                def uploaded(*_):
                    events.append('upload')
                    self.store.update(task['id'], result={'videoUrls': ['https://youtu.be/abcdefghijk']})
                with patch.object(web_service, 'test_authorization', return_value={'status': 'valid'}), \
                        patch.object(worker, 'check_browser_credentials', side_effect=lambda *_: events.append('preflight')), \
                        patch.object(worker, 'run_pipeline', side_effect=uploaded), \
                        patch.object(worker, 'apply_browser_rights', side_effect=lambda *_: events.append('browser')):
                    worker.execute(self.store.claim())
                self.assertEqual(events, ['preflight', 'upload', 'browser'] if enabled else ['upload'])
                self.assertEqual(self.store.get(task['id'])['status'], 'completed')

    def test_browser_preflight_failure_stops_download_and_upload(self):
        task = self.task(rightsManagement=True)
        worker = web_service.Worker(self.store)
        with patch.object(web_service, 'test_authorization', return_value={'status': 'valid'}), \
                patch.object(worker, 'check_browser_credentials', side_effect=ValueError('browser login expired')), \
                patch.object(worker, 'download') as download, patch.object(worker, 'run_pipeline') as upload:
            worker.execute(self.store.claim())
        download.assert_not_called()
        upload.assert_not_called()
        self.assertEqual(self.store.get(task['id'])['status'], 'failed')

    def test_stopped_task_cannot_modify_video(self):
        task = self.task(rightsManagement=True)
        self.store.update(task['id'], status='paused', result={'videoUrls': ['https://youtu.be/abcdefghijk']})
        worker = web_service.Worker(self.store)
        with patch.object(worker, 'apply_browser_rights') as apply:
            worker.finish_browser_rights(task)
            apply.assert_not_called()

    def test_missing_or_external_video_link_fails_closed(self):
        task = self.task(rightsManagement=True)
        worker = web_service.Worker(self.store)
        for links in ([], ['https://evil.example/video/abcdefghijk']):
            self.store.update(task['id'], status='processing', result={'videoUrls': links})
            with self.assertRaises(ValueError), patch.object(worker, 'apply_browser_rights') as apply:
                worker.finish_browser_rights(task)
            apply.assert_not_called()

    def test_desktop_bridge_passes_only_video_id_and_account(self):
        import desktop_bridge
        task = self.task(rightsManagement=True)
        worker = desktop_bridge.DesktopWorker(self.store)
        with patch.object(desktop_bridge, 'call_parent') as call:
            worker.check_browser_credentials(task)
            worker.apply_browser_rights(task, 'abcdefghijk')
        self.assertEqual(call.call_args.args, ('browser', dict(action='rights', accountId='default',
            taskId=task['id'], videoId='abcdefghijk')))
        self.assertEqual(call.call_args.kwargs['timeout'], 420)


if __name__ == '__main__':
    unittest.main()
