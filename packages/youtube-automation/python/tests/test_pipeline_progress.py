import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import sqlite3
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from ffmpeg_progress import progress_fields, run_media_process
from pipeline_events import PipelineStopped, progress_context
import upload_to_youtube as pipeline


class PipelineProgressTests(unittest.TestCase):
    def test_task_database_connections_close_and_rollback(self):
        from web_service import Store
        with tempfile.TemporaryDirectory() as directory:
            store = Store(directory)
            with store.connect() as db:
                db.execute("INSERT OR REPLACE INTO settings VALUES (1, ?)", (json.dumps({'paused': True}),))
            with self.assertRaises(sqlite3.ProgrammingError):
                db.execute('SELECT 1')
            with self.assertRaises(RuntimeError), store.connect() as db:
                db.execute("UPDATE settings SET value=? WHERE id=1", (json.dumps({'paused': False}),))
                raise RuntimeError('rollback')
            self.assertTrue(store.settings()['paused'])
    def test_real_media_time_percentage_and_eta(self):
        fields = progress_fields({'out_time_us': '50000000', 'speed': '2.0x', 'frame': '1500'}, 200, 25)
        self.assertEqual(fields['percent'], 25)
        self.assertEqual(fields['processedSeconds'], 50)
        self.assertEqual(fields['etaText'], '00:01:15')
        self.assertIsNone(progress_fields({}, None, 60)['percent'])
        self.assertNotIn('etaText', progress_fields({'speed': 'N/A'}, 100, 60))

    def test_file_progress_is_combined_with_completed_items(self):
        events = []
        script = "print('out_time_us=1000000',flush=True);print('speed=2x',flush=True);print('progress=end',flush=True)"
        with progress_context(stage='normalizing', completedItems=1, totalItems=3):
            result = run_media_process([sys.executable, '-u', '-c', script], duration=2,
                                       notify=lambda stage, **fields: events.append((stage, fields)))
        self.assertEqual(result.returncode, 0)
        self.assertTrue(any(fields['percent'] == 50 for _, fields in events))
        self.assertEqual(events[-1][1]['percent'], 66.7)
        self.assertEqual(events[-1][1]['completedItems'], 2)

    def test_silent_process_remains_cancellable(self):
        started = time.monotonic()
        def stop_check():
            if time.monotonic() - started > .15:
                raise PipelineStopped('test pause')
        with self.assertRaises(PipelineStopped):
            run_media_process([sys.executable, '-c', 'import time;time.sleep(30)'], stop_check=stop_check)
        self.assertLess(time.monotonic() - started, 4)

    def test_stderr_is_drained_and_bounded_without_losing_full_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'ffmpeg.log'
            result = run_media_process([sys.executable, '-c', "import sys;sys.stderr.write('x'*40000);sys.exit(3)"], log_path=log)
            self.assertEqual(result.returncode, 3)
            self.assertEqual(len(result.stderr), 8000)
            self.assertEqual(log.stat().st_size, 40000)

    def test_stdin_is_closed_for_background_children(self):
        result = run_media_process([sys.executable, '-c', "import sys;sys.exit(0 if sys.stdin.read()=='' else 1)"])
        self.assertEqual(result.returncode, 0)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_real_concat_and_full_decode_publish_progress(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'episode.mp4'
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                            'testsrc2=s=160x96:r=25', '-f', 'lavfi', '-i', 'sine=sample_rate=44100',
                            '-t', '0.6', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', str(source)],
                           check=True, capture_output=True, timeout=20)
            text = io.StringIO()
            with patch.dict(os.environ, {'DRAMAVOX_EVENTS': '1'}), contextlib.redirect_stdout(text):
                pipeline.merge_videos([source, source], root / 'merged.mp4', root / 'work')
            events = [json.loads(line.split(' ', 1)[1]) for line in text.getvalue().splitlines() if line.startswith('DRAMAVOX_EVENT ')]
            for stage in ['probing', 'merging', 'validating', 'checking_timestamps']:
                self.assertTrue(any(event['stage'] == stage and event.get('percent') == 100 for event in events), stage)
            self.assertTrue((root / 'merged.mp4').stat().st_size > 0)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_corrupt_video_validation_is_reported_as_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'broken.mp4'
            source.write_bytes(b'not a video')
            text = io.StringIO()
            with patch.dict(os.environ, {'DRAMAVOX_EVENTS': '1'}), contextlib.redirect_stdout(text):
                self.assertFalse(pipeline._verify_video_decode(source))
            events = [json.loads(line.split(' ', 1)[1]) for line in text.getvalue().splitlines() if line.startswith('DRAMAVOX_EVENT ')]
            finish = next(event for event in events if event.get('timing') == 'finish')
            self.assertEqual(finish['outcome'], 'failed')
            self.assertIn('[失败] 校验成片', text.getvalue())


if __name__ == '__main__':
    unittest.main()
