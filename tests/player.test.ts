import { describe, expect, it } from 'vitest';
import {
  formatTime,
  groupKey,
  groupVideos,
  latestWatchEntry,
  playbackEvent,
  playbackMessage,
  playbackUrl,
  playerCommand,
  playerUrl,
  resumeVideo,
} from '~/lib/player';
import { anime, video } from './fixtures';

describe('video groups and resume', () => {
  it('keeps providers and dubs separate and sorts episode numbers naturally', () => {
    const groups = groupVideos([
      video('10'),
      video('2'),
      video('1'),
      video('1', 'AniDub'),
      video('1', 'AniLibria', 2),
    ]);

    expect(groups.size).toBe(3);
    expect(groups.get(groupKey(video('1')))!.videos.map(v => v.number)).toEqual(['1', '2', '10']);
  });
  it('resumes by exact video ID and falls back to episode number when a provider replaces a video', () => {
    const videos = [video('1'), video('2')];
    const entry = {
      anime,
      episode: '2',
      group: groupKey(videos[1]),
      videoId: videos[1].video_id,
      updatedAt: 1,
    };

    expect(resumeVideo(videos, entry)).toEqual(videos[1]);
    expect(resumeVideo(videos, { ...entry, videoId: 999999 })).toEqual(videos[1]);
    expect(resumeVideo(videos, { ...entry, episode: '99', videoId: 999999 })).toEqual(videos[0]);
  });
  it('keeps the saved dubbing when the original video is no longer in the catalog', () => {
    const original = video('2', 'AniDub');
    const replacement = video('2', 'AniDub', 2);
    const entry = {
      anime,
      episode: original.number,
      group: groupKey(original),
      videoId: original.video_id,
      updatedAt: 100,
    };

    expect(resumeVideo([video('1'), video('2'), replacement], entry)).toBe(replacement);
  });
  it('allows only HTTPS iframe sources and rejects credential URLs', () => {
    expect(playerUrl('//player.example/video')).toBe('https://player.example/video');
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,unsafe',
      'http://player.example/video',
      'https://user:password@player.example',
      '/relative',
    ])
      expect(playerUrl(url)).toBe('');
  });
  it('omits videos with invalid iframe URLs', () => {
    expect(groupVideos([{ ...video('1'), iframe_url: 'javascript:alert(1)' }]).size).toBe(0);
  });
  it('resumes the newest server-side watched video in its original dubbing', () => {
    const first = { ...video('1'), watched: { date: 100, end_time: 200 } };
    const second = { ...video('3', 'AniDub'), watched: { date: 200, end_time: 300 } };

    expect(resumeVideo([first, second])).toBe(second);
  });
  it('builds a continue entry from per-title progress even outside the recent history page', () => {
    const first = { ...video('1'), duration: 1400, watched: { date: 100, end_time: 1400 } };
    const second = {
      ...video('2', 'StudioBand'),
      duration: 1441,
      watched: { date: 200, end_time: 30 },
    };

    expect(latestWatchEntry(anime, [second, first, video('3')])).toEqual({
      anime,
      videoId: second.video_id,
      group: groupKey(second),
      episode: '2',
      updatedAt: 200000,
      position: 30,
      duration: 1441,
    });
    expect(latestWatchEntry(anime, [video('1')])).toBeUndefined();
  });
  it('parses only finite progress from supported player messages', () => {
    expect(playbackMessage({ key: 'kodik_player_time_update', value: 120.5 })).toEqual({
      time: 120.5,
    });
    expect(playbackMessage({ key: 'player_duration_update', value: 1400 })).toEqual({
      duration: 1400,
    });
    expect(playbackMessage('{"event":"timeupdate","time":30}')).toEqual({ time: 30 });
    for (const value of [
      null,
      'bad JSON',
      { key: 'player_time_update', value: Infinity },
      { key: 'player_time_update', value: -1 },
      { key: 'unknown', value: 30 },
      { key: 'player_time_update', value: '120' },
    ])
      expect(playbackMessage(value)).toBeNull();
  });
  it('adds resume parameters only for known player protocols', () => {
    expect(
      playbackUrl({ ...video('1'), iframe_url: 'https://kodik.example/iframe' }, 120)
    ).toContain('start_from=115');
    expect(
      playbackUrl({ ...video('1'), iframe_url: 'https://alloha.example/iframe' }, 120)
    ).toContain('start=115');
    expect(playbackUrl(video('1'), 120)).toBe(video('1').iframe_url);
  });
  it('uses the actual Aksor seek API and ignores malformed playback events', () => {
    const aksor = { ...video('1'), iframe_url: 'https://player.aksor.tv/video/example' };

    expect(playerCommand(aksor, 'seek', 120)).toEqual({ key: 'player_seek', value: 120 });
    expect(playbackEvent({ key: 'kodik_player_video_ended' })).toBe('ended');
    expect(playbackEvent({ key: 123 })).toBeNull();
    expect(formatTime(3725)).toBe('1:02:05');
  });
});
