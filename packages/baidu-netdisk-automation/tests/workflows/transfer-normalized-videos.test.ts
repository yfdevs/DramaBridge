import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { matchBaiduEpisodeIndex } from '../../src/workflows/episode-index.js';
import { transferNormalizedEpisodeVideos } from '../../src/workflows/transfer-normalized-videos.js';
import { areBaiduNetdiskFilesStrictlyIdentical, baiduVideoSubtitleDirectoryPreference,
  collapseIdenticalRemoteEpisodeAliases, compareRemoteVideoDirectoryCandidates,
 } from '../../src/workflows/download-baidu-folder.js';

function fixture() {
  const source = (n: number, prefix = '/剧/有字幕') => ({ server_filename: `${n}.mp4`, path: `${prefix}/${n}.mp4`,
    fs_id: `${prefix}-${n}`, size: 100 + n, md5: `hash-${n}` });
  const own: any[] = []; const transferred: any[] = [];
  const directory = (name: string) => ({ server_filename: name, path: '/剧/' + name, isdir: 1 });
  const options: Parameters<typeof transferNormalizedEpisodeVideos>[0] = {
    title: '测试剧', episodeCount: 2, roots: [directory('有字幕'), directory('无字幕'), { server_filename: '版权.pdf' }],
    listShare: async path => [source(1, path), source(2, path), { server_filename: '海报.jpg', path: path + '/海报.jpg' }],
    listOwn: async () => own,
    createDirectory: async () => ({ path: '/测试剧', fs_id: 'root', isdir: 1 }),
    transferOne: async (entry, dest) => {
      transferred.push(entry); const item = { ...entry, path: dest + '/' + entry.server_filename, fs_id: 'own-' + entry.fs_id };
      own.push(item); return { item, transferred: true };
    },
    request: async (_url, init: any) => {
      const file = JSON.parse(init.body.get('filelist'))[0];
      const item = own.find(e => e.path === file.path); item.server_filename = file.newname; item.path = '/测试剧/' + file.newname;
      return { errno: 0 };
    }, token: 'test', identical: areBaiduNetdiskFilesStrictlyIdentical,
    compare: compareRemoteVideoDirectoryCandidates, subtitlePreference: baiduVideoSubtitleDirectoryPreference,
    collapseAliases: collapseIdenticalRemoteEpisodeAliases, episodeIndex: matchBaiduEpisodeIndex,
  };
  return { options, own, transferred, source };
}
test('transfers only the preferred complete video set, flattens and renames, and safely resumes', async () => {
  const f = fixture();
  const result = await runInNewContext('(' + transferNormalizedEpisodeVideos.toString() + ')(o)', {
    o: f.options, URLSearchParams, console, setTimeout, __name: (value: unknown) => value,
  });
  assert.equal(result.remoteVideos.files.length, 2);
  assert.deepEqual(f.own.map(e => e.path), ['/测试剧/测试剧-第1集.mp4', '/测试剧/测试剧-第2集.mp4']);
  assert.equal(f.transferred.length, 2);
  assert.ok(f.transferred.every(e => e.path.startsWith('/剧/有字幕/')));
  await transferNormalizedEpisodeVideos(f.options);
  assert.equal(f.transferred.length, 2, 'retry reuses content-verified final filenames');
});
test('incomplete episodes, conflicting targets and MOV never transfer files', async () => {
  for (const reason of ['missing', 'conflict', 'mov']) {
    const f = fixture();
    if (reason === 'missing') f.options.episodeCount = 3;
    if (reason === 'mov') f.options.listShare = async path => [1, 2].map(n => ({ ...f.source(n, path), server_filename: n + '.mov' }));
    if (reason === 'conflict') f.own.push({ server_filename: '测试剧-第1集.mp4', size: 101, md5: 'other' });
    await assert.rejects(transferNormalizedEpisodeVideos(f.options), /未找到完整|内容冲突|MOV/);
    assert.equal(f.transferred.length, 0);
  }
});
test('a rename rejection is a failure and a retry reuses the transferred original', async () => {
  const f = fixture(); const rename = f.options.request;
  f.options.request = async () => ({ errno: 12 });
  await assert.rejects(transferNormalizedEpisodeVideos(f.options), /改名失败/);
  assert.equal(f.own[0].server_filename, '1.mp4');
  f.options.transferOne = async entry => {
    const existing = f.own.find(e => e.server_filename === entry.server_filename);
    if (existing) return { item: existing, transferred: false };
    const item = { ...entry, fs_id: 'own-' + entry.fs_id, path: '/测试剧/' + entry.server_filename };
    f.own.push(item); return { item, transferred: true };
  };
  f.options.request = rename;
  await transferNormalizedEpisodeVideos(f.options);
  assert.equal(f.own.length, 2);
});

test('秋晴裁梦 has 64 parenthesized episodes in both variants; choose only the subtitled videos', async () => {
  const f = fixture();
  f.options.title = '秋晴裁梦'; f.options.episodeCount = 64;
  f.options.roots = ['无字幕版', '有字幕版'].map(version => ({ isdir: 1,
    server_filename: '秋晴裁梦' + version, path: '/奶酪说漫/秋晴裁梦/秋晴裁梦' + version }));
  f.options.listShare = async path => [
    ...Array.from({ length: 64 }, (_, index) => ({ ...f.source(index + 1, path), server_filename: `秋晴裁梦(${index + 1}).mp4` })),
    { server_filename: '秋晴裁梦封面.png' }, { server_filename: '秋晴裁梦srt.srt' }, { server_filename: '秋晴裁梦txt.txt' },
  ];
  // Stop before any cloud operation; the source selected for transfer is the assertion.
  f.options.transferOne = async source => {
    assert.ok(source.path.includes('有字幕版/'));
    assert.equal(source.index, 1);
    throw new Error('confirmed subtitled selection before cloud transfer');
  };
  await assert.rejects(transferNormalizedEpisodeVideos(f.options), /confirmed subtitled selection/);
  for (const name of ['秋晴裁梦(64).mp4', '秋晴裁梦（64）.mp4', '秋晴裁梦 ( 64 ).mp4']) {
    assert.equal(matchBaiduEpisodeIndex(name), 64);
  }
  assert.equal(matchBaiduEpisodeIndex('秋晴裁梦.mp4'), undefined);
});

test('isolates a normal task folder containing unrelated siblings', async () => {
  const f = fixture();
  f.own.push({ isdir: 1, path: '/测试剧/无字幕版', server_filename: '无字幕版', fs_id: 'old-directory' });
  const created: string[] = [];
  f.options.createDirectory = async (parent, name) => {
    const path = parent.replace(/\/$/, '') + '/' + name;
    created.push(path);
    return { path, server_filename: name, fs_id: path, isdir: 1 };
  };
  f.options.listOwn = async path => f.own.filter(entry => entry.path.slice(0, entry.path.lastIndexOf('/')) === path);
  f.options.transferOne = async (_source, destination) => {
    assert.match(destination, /测试剧-重新整理-/);
    assert.equal(f.own[0].fs_id, 'old-directory');
    throw new Error('confirmed clean normal destination');
  };
  await assert.rejects(transferNormalizedEpisodeVideos(f.options), /confirmed clean normal destination/);
  assert.equal(created.length, 2);
});

for (const recreation of [false, true]) {
  test(`${recreation ? 'recreation' : 'TikTok'} shares one task folder and preserves its hierarchy`, async () => {
    const f = fixture();
    f.options.recreation = recreation;
    f.options.versionTitle = recreation ? '新版本' : undefined;
    f.options.sharePassword = 'a1b2';
    const directories: any[] = [];
    f.options.createDirectory = async (parent, name) => {
      const path = parent.replace(/\/$/, '') + '/' + name;
      const entry = { path, server_filename: name, fs_id: path, isdir: 1 };
      directories.push(entry);
      return entry;
    };
    f.options.listOwn = async path => [...directories, ...f.own].filter(e => e.path.slice(0, e.path.lastIndexOf('/')) === path);
    f.options.listShare = async path => [...[1, 2].map(n => f.source(n, path)), { server_filename: '海报.jpg', path: path + '/海报.jpg', fs_id: 'cover-' + path, size: 1, md5: 'cover-hash' }];
    let shared: string[] = [];
    f.options.request = async (url, init: any) => {
      if (new URL(url, 'https://pan.baidu.com').pathname === '/share/set') {
        shared = JSON.parse(init.body.get('fid_list'));
        return { errno: 0, shareid: '123', link: 'https://pan.baidu.com/s/1result' };
      }
      const file = JSON.parse(init.body.get('filelist'))[0];
      const target = f.own.find(e => e.path === file.path);
      target.server_filename = file.newname;
      target.path = target.path.slice(0, target.path.lastIndexOf('/') + 1) + file.newname;
      return { errno: 0 };
    };
    const result = await runInNewContext('(' + transferNormalizedEpisodeVideos.toString() + ')(o)', {
      o: f.options, URL, URLSearchParams, console, setTimeout, __name: (value: unknown) => value,
    });
    const expected = recreation ? '/测试剧/新版本-60%' : '/测试剧';
    assert.deepEqual(shared, [expected]);
    assert.equal(result.resourceRootPath, expected);
    assert.equal(result.shareUrl, 'https://pan.baidu.com/s/1result?pwd=a1b2');
    if (recreation) {
      assert.ok(f.own.some(e => e.path.startsWith(expected + '/封面/')));
      assert.ok(f.own.some(e => e.path.startsWith(expected + '/成片60%/')));
      assert.ok(f.own.every(e => e.path.startsWith(expected + '/封面/') || e.path.startsWith(expected + '/成片60%/')));
    }
  });
}

test('cloud recreation keeps only first 60 percent and uses each version title', async () => {
  const f = fixture();
  f.options.recreation = true;
  f.options.versionTitle = '新版本';
  f.options.episodeCount = 5;
  f.options.listShare = async path => Array.from({length: 5}, (_, i) => f.source(i + 1, path));
  const created: string[] = [];
  f.options.createDirectory = async (parent, name) => {
    created.push(name);
    return { path: '/测试剧', fs_id: name, isdir: 1 };
  };
  const result = await transferNormalizedEpisodeVideos(f.options);
  assert.equal(result.remoteVideos.files.length, 3);
  assert.ok(created.includes('新版本-60%'));
  assert.ok(created.includes('封面'));
  assert.ok(created.includes('成片60%'));
  assert.deepEqual(result.remoteVideos.files.map((e: any) => e.name), ['新版本-第1集.mp4', '新版本-第2集.mp4', '新版本-第3集.mp4']);
});

 test('matches episode prefixes without mistaking years or embedded title numbers for episodes', () => {
  for (const filename of ['01-墙根那片薄荷.mp4', '01 墙根那片薄荷.mp4', '01墙根那片薄荷.mp4', 'EP01_墙根那片薄荷.mp4', '第01集-墙根那片薄荷.mp4']) {
    assert.equal(matchBaiduEpisodeIndex(filename), 1, filename);
  }
  for (const filename of ['2026墙根那片薄荷.mp4', '墙根71那片薄荷.mp4', '00 墙根那片薄荷.mp4']) {
    assert.equal(matchBaiduEpisodeIndex(filename), undefined, filename);
  }
});

test('selects a complete 71 episode set named with episode prefixes', async () => {
  const f = fixture();
  f.options.title = '墙根那片薄荷';
  f.options.episodeCount = 71;
  f.options.listShare = async path => Array.from({ length: 71 }, (_, i) => ({
    ...f.source(i + 1, path), server_filename: `${String(i + 1).padStart(2, '0')} 墙根那片薄荷.mp4`,
  }));
  f.options.transferOne = async source => {
    assert.equal(source.index, 1);
    assert.ok(source.path.startsWith('/剧/有字幕/'));
    throw new Error('confirmed prefix selection');
  };
  await assert.rejects(transferNormalizedEpisodeVideos(f.options), /confirmed prefix selection/);
});

test('recreation isolates stale extra episodes without deleting the previous task', async () => {
  const f = fixture();
  f.options.recreation = true;
  const directories: any[] = [
    { path: '/测试剧60%素材/成片60%', server_filename: '成片60%', fs_id: 'old-videos', isdir: 1 },
  ];
  f.own.push({ path: '/测试剧60%素材/成片60%/多余.mp4', server_filename: '多余.mp4', fs_id: 'extra' });
  f.options.createDirectory = async (parent, name) => {
    const path = parent.replace(/\/$/, '') + '/' + name;
    const entry = { path, server_filename: name, fs_id: path, isdir: 1 };
    if (!directories.some(item => item.path === path)) directories.push(entry);
    return entry;
  };
  f.options.listOwn = async path => [...directories, ...f.own].filter(item => item.path.slice(0, item.path.lastIndexOf('/')) === path);
  f.options.listShare = async path => [f.source(1, path), f.source(2, path)];
  f.options.transferOne = async (_source, dest) => {
    assert.match(dest, /重新整理-.*\/成片60%$/);
    assert.ok(f.own.some(item => item.fs_id === 'extra'));
    throw new Error('confirmed isolated task');
  };
  await assert.rejects(transferNormalizedEpisodeVideos(f.options), /confirmed isolated task/);
});

test('share failures preserve the API code and reason for diagnosis', async () => {
  const f = fixture();
  f.options.sharePassword = 'abcd';
  const rename = f.options.request;
  f.options.request = async (url, init) => new URL(url, 'https://pan.baidu.com').pathname === '/share/set'
    ? { errno: 115, show_msg: '分享数量超限', request_id: 'req-123' } : rename(url, init);
  await assert.rejects(transferNormalizedEpisodeVideos(f.options), /errno=115.*分享数量超限.*req-123/);
  assert.equal(f.transferred.length, 2);
});
test('a successful share link does not require an unused shareid field', async () => {
  const f = fixture();
  f.options.sharePassword = 'abcd';
  const rename = f.options.request;
  f.options.request = async (url, init) => new URL(url, 'https://pan.baidu.com').pathname === '/share/set'
    ? { errno: 0, link: 'https://pan.baidu.com/s/1test' } : rename(url, init);
  assert.equal((await transferNormalizedEpisodeVideos(f.options)).shareUrl, 'https://pan.baidu.com/s/1test?pwd=abcd');
});
