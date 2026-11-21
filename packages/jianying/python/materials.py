"""Verify imported material names without querying the search box."""
from collections import Counter
import time
from urllib.parse import unquote


def material_filenames(names):
    result = []
    prefix = "material.library.item."
    for name in names:
        if not name.startswith(prefix) or not name.endswith(".apply"):
            continue
        _, separator, filename = name[len(prefix):].partition(".")
        if separator and filename[:-6]:
            result.append(unquote(filename[:-6]))
    return result


def verify_materials(expected, read_names, progress, timeout=6):
    expected = list(expected)
    if len(set(expected)) != len(expected):
        raise RuntimeError("导入清单存在同名文件，无法准确核对，请先区分文件名")
    deadline = time.monotonic()+timeout
    counts = Counter()
    while True:
        counts = Counter(material_filenames(read_names()))
        duplicates = [name for name in expected if counts[name]>1]
        if duplicates:
            raise RuntimeError("素材面板存在同名重复记录："+"、".join(duplicates))
        missing = [name for name in expected if counts[name]==0]
        if not missing or time.monotonic()>=deadline:
            break
        time.sleep(0.2)
    batch_verified = len(expected)-len(missing)
    progress(f"批量核对素材 {batch_verified}/{len(expected)}")
    if missing:
        raise RuntimeError("导入素材核对缺少："+"、".join(missing)+"；未执行文字搜索")
    return {"verifiedMaterials":len(expected),"batchVerified":batch_verified,"searchedMaterials":0}
