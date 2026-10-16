import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import {
  handleAddSound,
  handleAudioPlay,
  handleAudioStop,
  handleCreatePlaylist,
  handleDeleteAudio,
  handleListAudio,
  handleSetSceneMusic,
  handleUpdateAudio,
} from '../audio.js';

const PL = 'PLAYLISTAAAAAAAA';
const PL2 = 'PLAYLISTBBBBBBBB';
const S1 = 'SOUNDAAAAAAAAAAA';
const S2 = 'SOUNDBBBBBBBBBBB';
const SCENE = 'SCENEAAAAAAAAAAA';

function snapshot() {
  return {
    playlists: [
      {
        _id: PL,
        name: 'Tavern',
        mode: 0,
        sorting: 'a',
        channel: 'music',
        sounds: [
          { _id: S1, name: 'Lute', path: 'a.ogg', volume: 0.5, playing: false },
          { _id: S2, name: 'Fiddle', path: 'b.ogg', volume: 0.7, playing: false },
        ],
      },
      {
        _id: PL2,
        name: 'Rain',
        mode: 2,
        channel: 'environment',
        sounds: [
          { _id: S1, name: 'Drops', path: 'c.ogg', playing: true },
          { _id: S2, name: 'Thunder', path: 'd.ogg', playing: false },
        ],
      },
    ],
    scenes: [{ _id: SCENE, name: 'Inn' }],
    folders: [{ _id: 'FOLDERAAAAAAAAAA', name: 'Music', type: 'Playlist' }],
  };
}

function client() {
  const calls = {
    update: vi.fn(async () => []),
    create: vi.fn(async () => [{ _id: 'NEWAAAAAAAAAAAAA' }]),
    del: vi.fn(async () => []),
  };
  const mock = {
    getWorldSnapshot: () => snapshot(),
    updateDocuments: calls.update,
    createDocuments: calls.create,
    deleteDocuments: calls.del,
  } as unknown as FoundryClient;
  return { mock, ...calls };
}

const textOf = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? '';

describe('audio handlers', () => {
  it('lists playlists and shows sounds with ids for one playlist', async () => {
    const { mock } = client();
    const all = textOf(await handleListAudio({}, mock));
    expect(all).toContain('**Tavern**');
    expect(all).toContain('Rain');
    expect(all).toContain('PLAYING');
    const one = textOf(await handleListAudio({ playlist: 'tavern' }, mock));
    expect(one).toContain(`\`${S1}\``);
    expect(one).toContain('Fiddle');
    const byTrack = textOf(await handleListAudio({ query: 'thunder' }, mock));
    expect(byTrack).toContain('Rain');
    expect(byTrack).not.toContain('Tavern');
  });

  it('plays the first track of a sequential playlist, like Foundry playAll', async () => {
    const { mock, update } = client();
    await handleAudioPlay({ playlist: 'Tavern' }, mock);
    // alphabetical order: Fiddle comes before Lute
    expect(update).toHaveBeenCalledWith('Playlist', [
      {
        _id: PL,
        playing: true,
        sounds: [
          { _id: S1, playing: false },
          { _id: S2, playing: true },
        ],
      },
    ]);
  });

  it('plays one sound and silences the others in a sequential playlist', async () => {
    const { mock, update } = client();
    await handleAudioPlay({ playlist: PL, sound: 'Lute' }, mock);
    expect(update).toHaveBeenCalledWith('Playlist', [
      {
        _id: PL,
        playing: true,
        sounds: [
          { _id: S1, playing: true },
          { _id: S2, playing: false, pausedTime: null },
        ],
      },
    ]);
  });

  it('plays one sound of a simultaneous playlist without touching the rest', async () => {
    const { mock, update } = client();
    await handleAudioPlay({ playlist: PL2, sound: 'Thunder' }, mock);
    expect(update).toHaveBeenCalledWith('Playlist', [
      { _id: PL2, playing: true, sounds: [{ _id: S2, playing: true }] },
    ]);
  });

  it('plays every sound of a simultaneous playlist', async () => {
    const { mock, update } = client();
    await handleAudioPlay({ playlist: 'Rain' }, mock);
    expect(update).toHaveBeenCalledWith('Playlist', [
      {
        _id: PL2,
        playing: true,
        sounds: [
          { _id: S1, playing: true },
          { _id: S2, playing: true },
        ],
      },
    ]);
  });

  it('stops everything that is playing when no playlist is given', async () => {
    const { mock, update } = client();
    const out = textOf(await handleAudioStop({}, mock));
    expect(out).toContain('Rain');
    expect(update).toHaveBeenCalledWith('Playlist', [
      {
        _id: PL2,
        playing: false,
        sounds: [
          { _id: S1, playing: false },
          { _id: S2, playing: false },
        ],
      },
    ]);
  });

  it('keeps the playlist playing when stopping one of several playing sounds', async () => {
    const { mock, update } = client();
    await handleAudioStop({ playlist: 'Rain', sound: 'Drops' }, mock);
    expect(update).toHaveBeenCalledWith('Playlist', [
      { _id: PL2, playing: false, sounds: [{ _id: S1, playing: false, pausedTime: null }] },
    ]);
  });

  it('refuses to play a soundboard playlist without a sound', async () => {
    const { mock, update } = client();
    const board = {
      ...mock,
      getWorldSnapshot: () => ({
        ...snapshot(),
        playlists: [{ ...snapshot().playlists[0], mode: -1 }],
      }),
    } as unknown as FoundryClient;
    await expect(handleAudioPlay({ playlist: 'Tavern' }, board)).rejects.toThrow(/soundboard/);
    expect(update).not.toHaveBeenCalled();
  });

  it('creates a playlist with v14 field values and a resolved folder', async () => {
    const { mock, create } = client();
    await handleCreatePlaylist(
      {
        name: 'Dungeon',
        mode: 'shuffle',
        channel: 'environment',
        sorting: 'manual',
        folder: 'Music',
      },
      mock,
    );
    expect(create).toHaveBeenCalledWith('Playlist', [
      {
        name: 'Dungeon',
        mode: 1,
        channel: 'environment',
        sorting: 'm',
        folder: 'FOLDERAAAAAAAAAA',
      },
    ]);
  });

  it('adds a sound as an embedded PlaylistSound', async () => {
    const { mock, create } = client();
    await handleAddSound({ playlist: 'Tavern', name: 'Drum', path: 'd.ogg', volume: 0.3 }, mock);
    expect(create).toHaveBeenCalledWith(
      'PlaylistSound',
      [{ name: 'Drum', path: 'd.ogg', volume: 0.3 }],
      `Playlist.${PL}`,
    );
  });

  it('updates a playlist or a sound and rejects fields for the wrong target', async () => {
    const { mock, update } = client();
    await handleUpdateAudio({ playlist: 'Tavern', mode: 'simultaneous', name: 'Inn' }, mock);
    expect(update).toHaveBeenCalledWith('Playlist', [{ _id: PL, name: 'Inn', mode: 2 }]);
    await handleUpdateAudio({ playlist: 'Tavern', sound: 'Lute', volume: 0.2, repeat: true }, mock);
    expect(update).toHaveBeenLastCalledWith(
      'PlaylistSound',
      [{ _id: S1, volume: 0.2, repeat: true }],
      `Playlist.${PL}`,
    );
    await expect(handleUpdateAudio({ playlist: 'Tavern', volume: 1 }, mock)).rejects.toThrow(
      /belong to a sound/,
    );
    await expect(
      handleUpdateAudio({ playlist: 'Tavern', sound: 'Lute', mode: 'shuffle' }, mock),
    ).rejects.toThrow(/belong to a playlist/);
    await expect(handleUpdateAudio({ playlist: 'Tavern' }, mock)).rejects.toThrow(/at least one/);
  });

  it('deletes a sound or a whole playlist', async () => {
    const { mock, del } = client();
    await handleDeleteAudio({ playlist: 'Tavern', sound: 'Fiddle' }, mock);
    expect(del).toHaveBeenCalledWith('PlaylistSound', [S2], `Playlist.${PL}`);
    await handleDeleteAudio({ playlist: 'Tavern' }, mock);
    expect(del).toHaveBeenLastCalledWith('Playlist', [PL]);
  });

  it('sets and clears scene music through the Scene playlist fields', async () => {
    const { mock, update } = client();
    await handleSetSceneMusic({ scene: 'Inn', playlist: 'Tavern', sound: 'Lute' }, mock);
    expect(update).toHaveBeenCalledWith('Scene', [{ _id: SCENE, playlist: PL, playlistSound: S1 }]);
    await handleSetSceneMusic({ scene: 'Inn', playlist: 'Tavern' }, mock);
    expect(update).toHaveBeenLastCalledWith('Scene', [
      { _id: SCENE, playlist: PL, playlistSound: null },
    ]);
    await handleSetSceneMusic({ scene: 'Inn', clear: true }, mock);
    expect(update).toHaveBeenLastCalledWith('Scene', [
      { _id: SCENE, playlist: null, playlistSound: null },
    ]);
    await expect(handleSetSceneMusic({ scene: 'Inn' }, mock)).rejects.toThrow(/clear=true/);
  });

  it('explains how to find a playlist that does not exist', async () => {
    const { mock } = client();
    await expect(handleAudioPlay({ playlist: 'Nope' }, mock)).rejects.toThrow(/foundry_audio list/);
  });
});
