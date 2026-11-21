"""Build durable per-episode rows from pipeline events."""


def update_episode_result(result, event):
    result = dict(result or {})
    index = event.get('episodeIndex')
    if not isinstance(index, int) or index < 1:
        return result
    rows = {row['index']: dict(row) for row in result.get('episodes', [])}
    row = rows.setdefault(index, {'index': index, 'status': 'queued'})
    # Replayed scan events must not erase completed uploads on resume.
    if event.get('episodeStatus') == 'queued' and row['status'] in {'completed', 'skipped'}:
        return result
    for source, target in [('episodeTitle', 'title'), ('episodeSource', 'source'),
                           ('episodeStatus', 'status'), ('stage', 'stage'),
                           ('percent', 'percent'), ('videoUrl', 'videoUrl')]:
        if source in event:
            row[target] = event[source]
    if event.get('outcome') == 'failed':
        row['status'] = 'failed'
    if row['status'] in {'completed', 'skipped'}:
        row['percent'] = 100
    result['episodes'] = [rows[key] for key in sorted(rows)]
    result['episodeCount'] = event.get('episodeCount', len(rows))
    result['completedEpisodes'] = sum(item['status'] in {'completed', 'skipped'} for item in rows.values())
    if event.get('videoUrl'):
        result['videoUrls'] = list(dict.fromkeys(result.get('videoUrls', []) + [event['videoUrl']]))
    return result
