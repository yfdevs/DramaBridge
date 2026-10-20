"""Write ordered video clips into a copied Jianying draft.

This executable is intentionally isolated from Electron.  Jianying's draft
codec loads the installed videoeditor.dll, so a codec crash cannot take down
the desktop application's main process.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

import pyJianYingDraft as draft


def _read_input(path: Path) -> tuple[list[str], int | None]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    values = payload.get("segments") if isinstance(payload, dict) else None
    if values is None and isinstance(payload, dict):
        values = payload.get("segmentFiles")
    if not isinstance(values, list) or not values:
        raise ValueError("分段列表为空")

    segments: list[str] = []
    for value in values:
        if not isinstance(value, str):
            raise ValueError("分段路径格式无效")
        resolved = str(Path(value).resolve())
        if not Path(resolved).is_file():
            raise FileNotFoundError(f"分段视频不存在：{Path(resolved).name}")
        segments.append(resolved)
    preferred = payload.get("preferredTimelineTime")
    if preferred is None:
        preferred = payload.get("previewTimelineTime")
    if preferred is not None and (not isinstance(preferred, (int, float)) or preferred < 0):
        raise ValueError("推荐预览时间格式无效")
    return segments, round(preferred) if preferred is not None else None


def _subtitle_free_time(
    script: Any,
    duration: int,
    preferred: int | None,
) -> tuple[int | None, int, int, list[tuple[int, int]]]:
    subtitle_tracks = [
        track for track in script.imported_tracks
        if track.track_type == draft.TrackType.text and len(getattr(track, "segments", [])) > 1
    ]
    if not subtitle_tracks:
        return min(preferred or 350_000, max(0, duration - 1)), 0, 1, [(0, duration)]

    # In Jianying's top-to-bottom overlay stack this is the fourth visible
    # track. Prefer its semantic name, then fall back to the multi-segment text
    # track for presets created by older Jianying versions.
    subtitle_track = next(
        (track for track in subtitle_tracks if "字幕" in getattr(track, "name", "")),
        max(subtitle_tracks, key=lambda track: len(track.segments)),
    )
    ranges = sorted(
        (segment.target_timerange.start, segment.target_timerange.end)
        for segment in subtitle_track.segments
    )
    merged: list[list[int]] = []
    for start, end in ranges:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])

    gaps: list[tuple[int, int]] = []
    cursor = 0
    for start, end in merged:
        if start > cursor:
            gaps.append((cursor, min(start, duration)))
        cursor = max(cursor, end)
    if cursor < duration:
        gaps.append((cursor, duration))

    margin = 150_000
    usable = [(start + margin, end - margin) for start, end in gaps if end - start >= margin * 2]
    if not usable:
        return None, len(ranges), len(gaps), []
    target = preferred if preferred is not None else usable[0][0]
    selected_range = min(
        usable,
        key=lambda value: abs(min(max(target, value[0]), value[1]) - target),
    )
    selected = min(max(target, selected_range[0]), selected_range[1])
    return selected, len(ranges), len(gaps), usable


def _remove_existing_video_content(script: Any) -> set[str]:
    removed_ids: set[str] = set()
    retained_tracks = []
    for track in script.imported_tracks:
        if track.track_type != draft.TrackType.video:
            retained_tracks.append(track)
            continue
        for segment in getattr(track, "segments", []):
            material_id = getattr(segment, "material_id", "")
            if material_id:
                removed_ids.add(material_id)
            raw_data = getattr(segment, "raw_data", {})
            if isinstance(raw_data, dict):
                removed_ids.update(
                    value for value in raw_data.get("extra_material_refs", [])
                    if isinstance(value, str)
                )
    script.imported_tracks = retained_tracks

    for material in script.imported_materials.get("videos", []):
        if isinstance(material, dict) and isinstance(material.get("id"), str):
            removed_ids.add(material["id"])
    script.imported_materials["videos"] = []

    for material_type, materials in list(script.imported_materials.items()):
        if not isinstance(materials, list):
            continue
        script.imported_materials[material_type] = [
            material for material in materials
            if not (
                isinstance(material, dict)
                and isinstance(material.get("id"), str)
                and material["id"] in removed_ids
            )
        ]
    return removed_ids


def _remove_missing_local_audio(script: Any) -> tuple[set[str], set[str]]:
    """Remove preset audio that only existed in the preset author's cache."""
    missing_ids: set[str] = set()
    missing_paths: set[str] = set()
    for material in script.imported_materials.get("audios", []):
        if not isinstance(material, dict):
            continue
        material_path = material.get("path")
        material_id = material.get("id")
        if not isinstance(material_path, str) or not isinstance(material_id, str):
            continue
        # Draft-relative placeholders are resolved by Jianying after opening.
        # Only absolute local paths can be validated at generation time.
        normalized_path = material_path.replace("/", os.sep).replace("\\", os.sep)
        if material_path.startswith("##_") or not os.path.isabs(normalized_path):
            continue
        if os.path.isfile(normalized_path):
            continue
        missing_ids.add(material_id)
        missing_paths.add(os.path.normcase(os.path.normpath(normalized_path)))

    if not missing_ids:
        return set(), set()

    removed_ids = set(missing_ids)
    retained_tracks = []
    for track in script.imported_tracks:
        if track.track_type != draft.TrackType.audio:
            retained_tracks.append(track)
            continue
        retained_segments = []
        for segment in getattr(track, "segments", []):
            if getattr(segment, "material_id", "") not in missing_ids:
                retained_segments.append(segment)
                continue
            raw_data = getattr(segment, "raw_data", {})
            if isinstance(raw_data, dict):
                removed_ids.update(
                    value for value in raw_data.get("extra_material_refs", [])
                    if isinstance(value, str)
                )
        track.segments = retained_segments
        if retained_segments:
            retained_tracks.append(track)
    script.imported_tracks = retained_tracks

    for material_type, materials in list(script.imported_materials.items()):
        if not isinstance(materials, list):
            continue
        script.imported_materials[material_type] = [
            material for material in materials
            if not (
                isinstance(material, dict)
                and isinstance(material.get("id"), str)
                and material["id"] in removed_ids
            )
        ]
    return removed_ids, missing_paths


def _purge_missing_paths_from_meta(
    meta_info_path: Path,
    codec: Any,
    missing_paths: set[str],
) -> None:
    if not missing_paths or not meta_info_path.is_file():
        return
    meta_info = codec.decode(meta_info_path.read_bytes())
    for bucket in meta_info.get("draft_materials", []):
        if not isinstance(bucket, dict) or not isinstance(bucket.get("value"), list):
            continue
        bucket["value"] = [
            value for value in bucket["value"]
            if not (
                isinstance(value, dict)
                and isinstance(value.get("file_Path"), str)
                and (
                    os.path.normcase(os.path.normpath(
                        value["file_Path"].replace("/", os.sep).replace("\\", os.sep)
                    )) in missing_paths
                    or (
                        os.path.isabs(value["file_Path"].replace("/", os.sep).replace("\\", os.sep))
                        and not os.path.isfile(
                            value["file_Path"].replace("/", os.sep).replace("\\", os.sep)
                        )
                    )
                )
            )
        ]
    encoded = codec.encode(json.dumps(meta_info, ensure_ascii=False, separators=(",", ":")))
    fd, temporary_name = tempfile.mkstemp(prefix=".draft_meta_info.", dir=meta_info_path.parent)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        temporary.write_bytes(encoded)
        os.replace(temporary, meta_info_path)
    finally:
        temporary.unlink(missing_ok=True)


def _main_timeline_id(draft_path: Path) -> str | None:
    project_path = draft_path / "Timelines" / "project.json"
    if not project_path.is_file():
        return None
    project = json.loads(project_path.read_text(encoding="utf-8-sig"))
    for key in ("main_timeline_id", "mainTimelineId", "timeline_id", "timelineId"):
        value = project.get(key) if isinstance(project, dict) else None
        if isinstance(value, str) and value:
            return value
    return None


def _replace_json_identifier(value: Any, old_id: str, new_id: str) -> Any:
    if isinstance(value, dict):
        return {
            (new_id if key == old_id else key): _replace_json_identifier(item, old_id, new_id)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_replace_json_identifier(item, old_id, new_id) for item in value]
    return new_id if value == old_id else value


def _write_plain_json(path: Path, value: Any) -> None:
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _refresh_copied_draft_identity(draft_path: Path, new_id: str) -> list[str]:
    """Keep Jianying's multi-timeline sidecars aligned with a cloned draft_id."""
    if not new_id:
        raise RuntimeError("新草稿未生成 draft_id")
    project_path = draft_path / "Timelines" / "project.json"
    if not project_path.is_file():
        return []
    project = json.loads(project_path.read_text(encoding="utf-8-sig"))
    old_id = project.get("main_timeline_id") if isinstance(project, dict) else None
    if not isinstance(old_id, str) or not old_id or old_id == new_id:
        return []

    json_paths = [
        project_path,
        project_path.with_name("project.json.bak"),
        draft_path / "draft_biz_config.json",
        draft_path / "timeline_layout.json",
    ]
    updated: list[str] = []
    for json_path in json_paths:
        if not json_path.is_file():
            continue
        payload = json.loads(json_path.read_text(encoding="utf-8-sig"))
        _write_plain_json(json_path, _replace_json_identifier(payload, old_id, new_id))
        updated.append(str(json_path))

    old_timeline_path = draft_path / "Timelines" / old_id
    new_timeline_path = draft_path / "Timelines" / new_id
    if old_timeline_path.is_dir():
        if new_timeline_path.exists():
            raise FileExistsError(f"新时间线目录已存在：{new_id}")
        old_timeline_path.rename(new_timeline_path)
        updated.append(str(new_timeline_path))
    return updated


def _atomic_copy(source: Path, target: Path) -> None:
    if not target.is_file():
        return
    backup = target.with_name(f"{target.name}.dramabridge.bak")
    if not backup.exists():
        shutil.copy2(target, backup)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        shutil.copy2(source, temporary)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def _sync_mirrors(draft_path: Path, source: Path) -> list[str]:
    targets = [draft_path / "template-2.tmp"]
    timeline_id = _main_timeline_id(draft_path)
    if timeline_id:
        timeline = draft_path / "Timelines" / timeline_id
        targets.extend([timeline / "draft_content.json", timeline / "template-2.tmp"])
    updated: list[str] = []
    for target in targets:
        if target.resolve() == source.resolve() or not target.is_file():
            continue
        _atomic_copy(source, target)
        updated.append(str(target))
    return updated


def _update_video_material_store(
    draft_path: Path,
    material_ids: list[str],
    removed_material_ids: set[str],
) -> Path:
    """Expose generated timeline videos in Jianying's local material panel."""
    store_path = draft_path / "draft_virtual_store.json"
    if store_path.is_file():
        store = json.loads(store_path.read_text(encoding="utf-8-sig"))
    else:
        store = {"draft_materials": [], "draft_virtual_store": []}

    virtual_store = store.setdefault("draft_virtual_store", [])
    filter_entry = next((item for item in virtual_store if item.get("type") == 0), None)
    if filter_entry is None:
        filter_entry = {"type": 0, "value": [{}]}
        virtual_store.append(filter_entry)
    filter_values = filter_entry.setdefault("value", [{}])
    if not filter_values:
        filter_values.append({})
    filter_values[0].update({
        "id": "",
        "display_name": "",
        "creation_time": 0,
        "import_time": 0,
        "import_time_us": 0,
        "filter_type": 1,
        "sort_type": 0,
        "sort_sub_type": 0,
    })

    ordering_entry = next((item for item in virtual_store if item.get("type") == 1), None)
    if ordering_entry is None:
        ordering_entry = {"type": 1, "value": []}
        virtual_store.append(ordering_entry)
    ordering = ordering_entry.setdefault("value", [])
    ordering[:] = [
        item for item in ordering
        if not (
            isinstance(item, dict)
            and item.get("child_id") in removed_material_ids
        )
    ]
    known_ids = {
        item.get("child_id") for item in ordering
        if isinstance(item, dict) and isinstance(item.get("child_id"), str)
    }
    for material_id in material_ids:
        if material_id not in known_ids:
            ordering.append({"child_id": material_id, "parent_id": ""})

    fd, temporary_name = tempfile.mkstemp(prefix=".draft_virtual_store.", dir=draft_path)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        temporary.write_text(
            json.dumps(store, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(temporary, store_path)
    finally:
        temporary.unlink(missing_ok=True)
    return store_path


def write_track(
    draft_path: Path,
    install_dir: Path,
    input_path: Path,
    register_as_new_draft: bool = False,
) -> dict[str, Any]:
    draft_path = draft_path.resolve()
    install_dir = install_dir.resolve()
    if not draft_path.is_dir():
        raise FileNotFoundError("剪映草稿目录不存在")
    if not (install_dir / "videoeditor.dll").is_file():
        raise FileNotFoundError("剪映安装目录中缺少 videoeditor.dll")

    segments, preferred_time = _read_input(input_path.resolve())
    codec = draft.JianyingDraftCryptoCodec(
        draft.DraftCryptoConfig(
            jy_install_dir=str(install_dir),
            # The worker process itself is the crash boundary. A second Python
            # subprocess cannot reliably re-enter a PyInstaller one-file app.
            isolated=False,
            validate_roundtrip=True,
        )
    )
    folder = draft.DraftFolder(str(draft_path.parent), content_codec=codec)
    script = folder.load_template(draft_path.name)
    if register_as_new_draft:
        # Episode drafts are filesystem copies of a preset. Treat the first
        # save like DraftFolder.duplicate_as_template() so the copy receives
        # its own draft_id instead of trying to claim the preset's registered
        # identity. Reconfiguring is intentional: load_template() initially
        # attaches existing-draft save hooks.
        folder._registration.configure_script_file(
            script,
            draft_path.name,
            is_new_draft=True,
        )
    materials = [draft.VideoMaterial(segment) for segment in segments]
    subtitle_free_time, subtitle_count, subtitle_gap_count, subtitle_free_ranges = _subtitle_free_time(
        script,
        sum(material.duration for material in materials),
        preferred_time,
    )
    missing_audio_ids, missing_audio_paths = _remove_missing_local_audio(script)
    removed_material_ids = _remove_existing_video_content(script) | missing_audio_ids

    track = script.insert_track(
        draft.TrackSpec(draft.TrackType.video, "自动视频轨道", mute=True),
        at_index=0,
    )
    cursor = 0
    durations: list[int] = []
    for material in materials:
        duration = material.duration
        script.add_segment(
            draft.VideoSegment(
                material,
                draft.Timerange(cursor, duration),
                source_timerange=draft.Timerange(0, duration),
                volume=0.0,
            ),
            track,
        )
        durations.append(duration)
        cursor += duration

    material_ids = [
        material_id for material_id in
        (getattr(material, "material_id", "") for material in materials)
        if isinstance(material_id, str) and material_id
    ]
    if len(material_ids) != len(materials):
        raise RuntimeError("无法生成剪映素材库索引")
    material_store_path = _update_video_material_store(
        draft_path,
        material_ids,
        removed_material_ids,
    )

    content_path = draft_path / "draft_content.json"
    meta_info_path = draft_path / "draft_meta_info.json"
    script.duration = max(script.duration, cursor)
    # Use the template-aware save path instead of dumping only the timeline.
    # pyJianYingDraft's after-save hook synchronizes draft_meta_info.json with
    # every local video material, which makes the clips appear in Jianying's
    # material panel without driving the Import dialog through UI automation.
    script.save_path = str(content_path)
    script.save()
    if not meta_info_path.is_file():
        raise RuntimeError("草稿素材索引写入失败")
    _purge_missing_paths_from_meta(meta_info_path, codec, missing_audio_paths)
    identity_files = _refresh_copied_draft_identity(
        draft_path,
        str(script.content.get("id", "")),
    ) if register_as_new_draft else []
    mirrors = _sync_mirrors(draft_path, content_path)

    source_hash = hashlib.sha256(content_path.read_bytes()).hexdigest()
    for mirror in mirrors:
        if hashlib.sha256(Path(mirror).read_bytes()).hexdigest() != source_hash:
            raise RuntimeError(f"草稿镜像校验失败：{Path(mirror).name}")

    # A final decode catches both encryption and persistence problems before
    # Jianying is ever started with the generated draft.
    verified = codec.decode(content_path.read_bytes())
    video_tracks = [track for track in verified.get("tracks", []) if track.get("type") == "video"]
    verified_segments = sum(len(track.get("segments", [])) for track in video_tracks)
    if verified_segments != len(segments):
        raise RuntimeError("草稿回读后的视频片段数量不一致")

    verified_meta = codec.decode(meta_info_path.read_bytes())
    indexed_paths = {
        os.path.normcase(os.path.normpath(str(value.get("file_Path", ""))))
        for bucket in verified_meta.get("draft_materials", [])
        if isinstance(bucket, dict) and bucket.get("type") == 0
        for value in bucket.get("value", [])
        if isinstance(value, dict) and value.get("file_Path")
    }
    missing_indexes = [
        segment for segment in segments
        if os.path.normcase(os.path.normpath(segment)) not in indexed_paths
    ]
    if missing_indexes:
        raise RuntimeError("草稿素材索引回读后的视频片段数量不一致")

    return {
        "success": True,
        "mediaLibraryWritten": True,
        "videoCount": len(segments),
        "duration": cursor,
        "segmentDurations": durations,
        "subtitleFreeTimelineTime": subtitle_free_time,
        "subtitleTrackSegmentCount": subtitle_count,
        "subtitleGapCount": subtitle_gap_count,
        "subtitleFreeRanges": subtitle_free_ranges,
        "removedMissingAudioCount": len(missing_audio_paths),
        "sha256": source_hash,
        "updatedFiles": [
            str(content_path),
            str(meta_info_path),
            str(material_store_path),
            *identity_files,
            *mirrors,
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    write_parser = subparsers.add_parser("write-track")
    write_parser.add_argument("--draft", required=True)
    write_parser.add_argument("--install-dir", required=True)
    write_parser.add_argument("--input", required=True)
    write_parser.add_argument("--register-as-new-draft", action="store_true")
    args = parser.parse_args()

    try:
        result = write_track(
            Path(args.draft),
            Path(args.install_dir),
            Path(args.input),
            register_as_new_draft=args.register_as_new_draft,
        )
        # Keep stdout ASCII-only so Electron receives stable JSON regardless of
        # the Windows console code page used by the packaged worker.
        print(json.dumps(result, ensure_ascii=True, separators=(",", ":")), flush=True)
        return 0
    except Exception as error:
        print(json.dumps({"success": False, "message": str(error)}, ensure_ascii=True), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
