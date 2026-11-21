import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import upload_to_youtube as pipeline


class MergeDurationTests(unittest.TestCase):
    def reconcile(self, points, *, stderr='', returncode=0):
        video = dict(r_frame_rate='30/1', nb_frames='3', duration='0.200651')
        result = subprocess.CompletedProcess([], returncode, stdout=points, stderr=stderr)
        with patch.object(pipeline.subprocess, 'run', return_value=result):
            pipeline._reconcile_video_duration(Path('episode.mp4'), video)
        return video

    def test_corrects_legacy_edit_list_duration_after_verifying_reordered_pts(self):
        video = self.reconcile('0.166667\n0.100000\n0.133333\n')
        self.assertAlmostEqual(float(video['duration']), .1)
        self.assertEqual(video['reported_duration'], '0.200651')
        self.assertEqual(video['duration_basis'], 'verified_packet_timestamps')

    def test_preserves_invalid_or_variable_timeline(self):
        for points in ['0.1\n0.133333\n', '0.1\n0.133333\n0.2\n',
                       '0.1\n0.1\n0.166667\n', 'NaN\n0.133333\n0.166667\n', 'N/A\n']:
            with self.subTest(points=points):
                self.assertEqual(self.reconcile(points)['duration'], '0.200651')

    def test_probe_failure_does_not_override_duration(self):
        self.assertEqual(self.reconcile('', returncode=1)['duration'], '0.200651')
        self.assertEqual(self.reconcile('0.1\n0.133333\n0.166667\n', stderr='decode error')['duration'], '0.200651')

    def test_consistent_duration_needs_no_packet_probe(self):
        video = dict(r_frame_rate='30/1', nb_frames='3', duration='.1')
        with patch.object(pipeline.subprocess, 'run') as probe:
            pipeline._reconcile_video_duration(Path('episode.mp4'), video)
        probe.assert_not_called()


if __name__ == '__main__':
    unittest.main()
