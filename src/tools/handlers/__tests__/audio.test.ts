import { describe, expect, it } from 'vitest';
import { fakeFoundry } from '../../../test-utils/fake-foundry.js';
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

const world = () => {
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
};

function setup() {
  return fakeFoundry({ world: world() });
}
type Fake = ReturnType<typeof setup>;

type Row = Record<string, unknown>;
const playlist = (f: Fake, id: string) => f.world.playlists?.find((p) => p._id === id) as Row;
const sound = (f: Fake, pl: string, id: string) =>
  (playlist(f, pl).sounds as Row[]).find((s) => s._id === id) as Row;
const playing = (f: Fake, pl: string) =>
  (playlist(f, pl).sounds as Row[]).filter((s) => s.playing).map((s) => s.name);
const writes = (f: Fake) => f.sent.filter((s) => s.action !== 'get');

const textOf = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? '';

describe('audio listing', () => {
  it('lists playlists and shows sounds with ids for one playlist', async () => {
    const { client } = setup();
    const all = textOf(await handleListAudio({}, client));
    expect(all).toContain('**Tavern**');
    expect(all).toContain('Rain');
    expect(all).toContain('PLAYING');
    const one = textOf(await handleListAudio({ playlist: 'tavern' }, client));
    expect(one).toContain(`\`${S1}\``);
    expect(one).toContain('Fiddle');
    const byTrack = textOf(await handleListAudio({ query: 'thunder' }, client));
    expect(byTrack).toContain('Rain');
    expect(byTrack).not.toContain('Tavern');
  });

  it('pages the playlist list with offset and a footer', async () => {
    const { client } = setup();
    const second = textOf(await handleListAudio({ limit: 1, offset: 1 }, client));
    expect(second).toContain('**Rain**');
    expect(second).not.toContain('**Tavern**');
    expect(second).toContain('_Showing 2–2 of 2._');
  });
});

describe('audio play / stop', () => {
  it('plays the first track of a sequential playlist, like Foundry playAll', async () => {
    const f = setup();
    await handleAudioPlay({ playlist: 'Tavern' }, f.client);
    // Alphabetical order: Fiddle comes before Lute.
    expect(playlist(f, PL).playing).toBe(true);
    expect(playing(f, PL)).toEqual(['Fiddle']);
  });

  it('plays one sound and silences the others in a sequential playlist', async () => {
    const f = setup();
    await handleAudioPlay({ playlist: PL, sound: 'Lute' }, f.client);
    expect(playing(f, PL)).toEqual(['Lute']);
    expect(playlist(f, PL).playing).toBe(true);
  });

  it('plays one sound of a simultaneous playlist without touching the rest', async () => {
    const f = setup();
    await handleAudioPlay({ playlist: PL2, sound: 'Thunder' }, f.client);
    expect(playing(f, PL2)).toEqual(['Drops', 'Thunder']);
    expect(playlist(f, PL2).playing).toBe(true);
  });

  it('plays every sound of a simultaneous playlist', async () => {
    const f = setup();
    await handleAudioPlay({ playlist: 'Rain' }, f.client);
    expect(playing(f, PL2)).toEqual(['Drops', 'Thunder']);
  });

  it('stops everything that is playing when no playlist is given', async () => {
    const f = setup();
    const out = textOf(await handleAudioStop({}, f.client));
    expect(out).toContain('Rain');
    expect(playlist(f, PL2).playing).toBe(false);
    expect(playing(f, PL2)).toEqual([]);
  });

  it('stops one of several playing sounds', async () => {
    const f = fakeFoundry({ world: world() });
    await handleAudioPlay({ playlist: 'Rain' }, f.client);
    await handleAudioStop({ playlist: 'Rain', sound: 'Drops' }, f.client);
    expect(playing(f, PL2)).toEqual(['Thunder']);
    expect(sound(f, PL2, S1).pausedTime).toBeNull();
  });

  it('refuses to play a soundboard playlist without a sound', async () => {
    const w = world();
    (w.playlists[0] as Row).mode = -1;
    const f = fakeFoundry({ world: w });
    await expect(handleAudioPlay({ playlist: 'Tavern' }, f.client)).rejects.toThrow(/soundboard/);
    expect(writes(f)).toEqual([]);
  });

  it('explains how to find a playlist that does not exist', async () => {
    const f = setup();
    await expect(handleAudioPlay({ playlist: 'Nope' }, f.client)).rejects.toThrow(
      /foundry_audio list/,
    );
  });
});

describe('audio edits', () => {
  it('creates a playlist with v14 field values and a resolved folder', async () => {
    const f = setup();
    await handleCreatePlaylist(
      {
        name: 'Dungeon',
        mode: 'shuffle',
        channel: 'environment',
        sorting: 'manual',
        folder: 'Music',
      },
      f.client,
    );
    const created = f.world.playlists?.at(-1);
    expect(created).toMatchObject({
      name: 'Dungeon',
      mode: 1,
      channel: 'environment',
      sorting: 'm',
      folder: 'FOLDERAAAAAAAAAA',
    });
    expect(String(created?._id)).toHaveLength(16);
  });

  it('adds a sound as an embedded PlaylistSound', async () => {
    const f = setup();
    await handleAddSound(
      { playlist: 'Tavern', name: 'Drum', path: 'd.ogg', volume: 0.3 },
      f.client,
    );
    expect((playlist(f, PL).sounds as Row[]).at(-1)).toMatchObject({
      name: 'Drum',
      path: 'd.ogg',
      volume: 0.3,
    });
  });

  it('updates a playlist or a sound', async () => {
    const f = setup();
    await handleUpdateAudio({ playlist: 'Tavern', mode: 'simultaneous', name: 'Inn' }, f.client);
    expect(playlist(f, PL)).toMatchObject({ name: 'Inn', mode: 2 });
    await handleUpdateAudio(
      { playlist: 'Inn', sound: 'Lute', volume: 0.2, repeat: true },
      f.client,
    );
    expect(sound(f, PL, S1)).toMatchObject({ volume: 0.2, repeat: true });
    expect(sound(f, PL, S2).volume).toBe(0.7);
  });

  it('rejects fields for the wrong target, and an empty update', async () => {
    const f = setup();
    await expect(handleUpdateAudio({ playlist: 'Tavern', volume: 1 }, f.client)).rejects.toThrow(
      /belong to a sound/,
    );
    await expect(
      handleUpdateAudio({ playlist: 'Tavern', sound: 'Lute', mode: 'shuffle' }, f.client),
    ).rejects.toThrow(/belong to a playlist/);
    await expect(handleUpdateAudio({ playlist: 'Tavern' }, f.client)).rejects.toThrow(
      /at least one/,
    );
    expect(writes(f)).toEqual([]);
  });

  it('deletes a sound or a whole playlist', async () => {
    const f = setup();
    await handleDeleteAudio({ playlist: 'Tavern', sound: 'Fiddle' }, f.client);
    expect((playlist(f, PL).sounds as Row[]).map((s) => s.name)).toEqual(['Lute']);
    await handleDeleteAudio({ playlist: 'Tavern' }, f.client);
    expect(f.world.playlists?.map((p) => p._id)).toEqual([PL2]);
  });

  it('sets and clears scene music through the Scene playlist fields', async () => {
    const f = setup();
    const scene = () => f.world.scenes?.[0] as Row;
    await handleSetSceneMusic({ scene: 'Inn', playlist: 'Tavern', sound: 'Lute' }, f.client);
    expect(scene()).toMatchObject({ playlist: PL, playlistSound: S1 });
    await handleSetSceneMusic({ scene: 'Inn', playlist: 'Tavern' }, f.client);
    expect(scene()).toMatchObject({ playlist: PL, playlistSound: null });
    await handleSetSceneMusic({ scene: 'Inn', clear: true }, f.client);
    expect(scene()).toMatchObject({ playlist: null, playlistSound: null });
    await expect(handleSetSceneMusic({ scene: 'Inn' }, f.client)).rejects.toThrow(/clear=true/);
  });
});
