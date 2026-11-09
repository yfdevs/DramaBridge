import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import upload_to_youtube as pipeline
from web_service import validate_task


class MuteTests(unittest.TestCase):
    def test_validation(self):
        body = dict(resourceName='测试', shareText='https://pan.baidu.com/s/test', mode='mute', compress=True)
        self.assertTrue(validate_task(body)['compress'])
        for invalid in [dict(body, mode='merge'), dict(body, compress='true')]:
            with self.assertRaises(ValueError):
                validate_task(invalid)
        with self.assertRaises(SystemExit):
            pipeline.parse_args(['test.mp4', '--compress'])

    def test_order_cache_and_smaller_compression(self):
        for compressed_size in [2, 6]:
            with self.subTest(size=compressed_size), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                source = root / 'series'
                source.mkdir()
                for name in ['ep10.mp4', 'ep2.mp4']:
                    (source / name).write_bytes(b'original')
                args = pipeline.parse_args([str(source), '--mute', '--compress', '--no-upload'])
                args.temporary_outputs = True
                calls = []
                def merge(videos, output, *a, **kw):
                    self.assertEqual([v.name for v in videos], ['ep2.mp4', 'ep10.mp4'])
                    output.touch()
                    calls.append('merge')
                def ffmpeg(command):
                    self.assertIn('-an', command)
                    codec = command[command.index('-c:v') + 1]
                    Path(command[-1]).write_bytes(b'x' * (4 if codec == 'copy' else compressed_size))
                    calls.append(codec)
                with patch.object(pipeline, 'merge_videos', merge), patch.object(pipeline, '_run_ffmpeg', ffmpeg), patch.object(pipeline, '_probe_stream_signature', return_value=[{'codec_type': 'audio'}]):
                    output = pipeline._main_batch(source, args, root / 'work', root)
                    self.assertEqual(output.stat().st_size, min(4, compressed_size))
                    self.assertEqual(output.parent, root / 'work' / 'outputs')
                    self.assertEqual(pipeline._main_batch(source, args, root / 'work', root), output)
                    self.assertEqual(calls, ['merge', 'copy', 'libx264'])
                    self.assertEqual((source / 'ep2.mp4').read_bytes(), b'original')
                    self.assertEqual(len(list(source.iterdir())), 2)

    def test_real_ffmpeg_single_and_mixed_audio_batch(self):
        import subprocess
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'series'
            source.mkdir()
            for index, audio in [(1, True), (2, False)]:
                command = ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=128x128:r=24:d=0.5']
                if audio:
                    command += ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-c:a', 'aac']
                command += ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source / f'ep{index}.mp4')]
                subprocess.run(command, check=True, capture_output=True)
            for input_path in [source / 'ep1.mp4', source]:
                output = pipeline.main([str(input_path), '--mute', '--compress', '--no-upload'], work_dir=root / 'work')
                streams = pipeline._probe_stream_signature(output)
                self.assertEqual([s['codec_type'] for s in streams], ['video'])
                self.assertTrue(output.is_file())


if __name__ == '__main__':
    unittest.main()
