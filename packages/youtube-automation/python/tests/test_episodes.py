import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import upload_to_youtube as pipeline
from pipeline_events import PREFIX, timed_stage, emit
from episode_progress import update_episode_result
from web_service import validate_task, Store, Worker


class EpisodeTests(unittest.TestCase):
    def test_service_accepts_episode_mode(self):
        self.assertEqual(validate_task(dict(resourceName='剧名', shareText='https://pan.baidu.com/s/test',
                                            mode='episodes'))['mode'], 'episodes')

    def test_order_titles_interleaving_and_resume(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'series'
            source.mkdir()
            for name in ['ep10.mp4', 'ep2.mp4', 'ep1.mp4']:
                (source / name).write_bytes(b'input')
            args = pipeline.parse_args([str(source), '--episodes', '--title', '剧名',
                                        '--upload-log', str(root / 'uploaded.json')])
            calls = []
            def process(video, *_):
                calls.append(('process', video.name))
                with timed_stage('separating'):
                    emit('separating', 50)
                return video
            def upload(youtube, video, output, thumbnail, title, args, script, work, key):
                calls.append(('upload', title))
                pipeline.mark_uploaded(args.upload_log, key, 'id' + str(len(calls)))
            output = io.StringIO()
            with patch.dict(os.environ, DRAMAVOX_EVENTS='1'), contextlib.redirect_stdout(output), \
                    patch.object(pipeline, 'process_video', process), \
                    patch.object(pipeline, '_get_youtube_service', return_value=object()), \
                    patch.object(pipeline, '_upload_processed_video', upload), \
                    patch.object(pipeline, 'merge_videos', side_effect=AssertionError('must not merge')):
                pipeline._main_batch(source, args, root / 'work', root)
                self.assertEqual(calls, [('process', 'ep1.mp4'), ('upload', '剧名-第1集'),
                                         ('process', 'ep2.mp4'), ('upload', '剧名-第2集'),
                                         ('process', 'ep10.mp4'), ('upload', '剧名-第3集')])
                calls.clear()
                pipeline._main_batch(source, args, root / 'work', root)
                self.assertEqual(calls, [])
            events = [json.loads(line[len(PREFIX):]) for line in output.getvalue().splitlines() if line.startswith(PREFIX)]
            separating = [event for event in events if event['stage'] == 'separating']
            self.assertTrue(all(event['episodeIndex'] in [1, 2, 3] for event in separating))
            result = {}
            for event in events:
                result = update_episode_result(result, event)
            self.assertEqual(result['completedEpisodes'], 3)
            self.assertEqual(len(result['videoUrls']), 3)
            self.assertTrue(all(row['status'] == 'skipped' for row in result['episodes']))

    def test_failure_stops_later_episodes_and_no_upload_needs_no_auth(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            videos = [root / '1.mp4', root / '2.mp4']
            args = pipeline.parse_args([str(root), '--episodes', '--no-upload'])
            with patch.object(pipeline, 'process_video', side_effect=RuntimeError('separation failed')) as process, \
                    patch.object(pipeline, '_get_youtube_service') as auth:
                with self.assertRaisesRegex(RuntimeError, 'separation failed'):
                    pipeline._main_episodes(videos, args, root, root, '剧名')
                self.assertEqual(process.call_count, 1)
                auth.assert_not_called()
            with patch.object(pipeline, 'process_video', side_effect=videos), patch.object(pipeline, '_get_youtube_service') as auth:
                self.assertEqual(pipeline._main_episodes(videos, args, root, root, '剧名'), videos)
                auth.assert_not_called()

    def test_worker_persists_episode_progress_and_uses_drama_name(self):
        import web_service
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'app').mkdir()
            (root / 'app' / 'upload_to_youtube.py').write_text(
                "import sys,json\n"
                "assert '--episodes' in sys.argv and '--merge' not in sys.argv\n"
                "assert sys.argv[sys.argv.index('--title')+1] == 'drama'\n"
                "for index in (1,2):\n"
                " print('DRAMAVOX_EVENT '+json.dumps(dict(stage='separating',episodeIndex=index,episodeCount=2,episodeTitle='drama-'+str(index),episodeStatus='processing',percent=50)),flush=True)\n"
                " print('DRAMAVOX_EVENT '+json.dumps(dict(stage='preparing',episodeIndex=index,episodeCount=2,episodeStatus='completed',percent=100)),flush=True)\n",
                encoding='utf-8')
            store = Store(root / 'data')
            task = store.create(dict(resourceName='drama', title='custom', shareText='https://pan.baidu.com/s/test', mode='episodes', noUpload=True))
            store.update(task['id'], status='processing')
            with patch.object(web_service, 'ROOT', root):
                Worker(store).run_pipeline(store.get(task['id']), root)
            self.assertEqual(store.get(task['id'])['result']['completedEpisodes'], 2)
            self.assertEqual(len(store.get(task['id'])['result']['episodes']), 2)
            self.assertNotIn('episodes', store.list()[0]['result'])


if __name__ == '__main__':
    unittest.main()
