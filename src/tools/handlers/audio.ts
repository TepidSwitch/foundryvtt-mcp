/**
 * @fileoverview Audio tools: playlists and sounds, playback, scene music
 *
 * Writes use `modifyDocument` on Playlist and (embedded) PlaylistSound. Playback
 * mirrors what Foundry's own Playlist#playAll / playSound / stopSound / stopAll
 * send, so every connected client starts and stops audio exactly as it does
 * when the GM clicks in the sidebar. A Playlist's `playing` flag is derived
 * from its sounds on the client, so the sound flags are what matter.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { WorldData } from '../../foundry/types.js';
import { isRec, num, type Rec, str } from './dnd5e.js';
import { resolveFolder } from './import-place.js';
import { resolveByRef, snapshotOf } from './refs.js';
import { pageSlice, withToolError } from './utils.js';

/** CONST.PLAYLIST_MODES */
export const PLAYLIST_MODES = {
  disabled: -1,
  sequential: 0,
  shuffle: 1,
  simultaneous: 2,
} as const;
export type PlaylistModeName = keyof typeof PLAYLIST_MODES;

const MODE_NAMES = new Map<number, PlaylistModeName>(
  (Object.entries(PLAYLIST_MODES) as Array<[PlaylistModeName, number]>).map(([n, v]) => [v, n]),
);

export type AudioChannel = 'music' | 'environment' | 'interface';
export type PlaylistSorting = 'alphabetical' | 'manual';
const SORTING: Record<PlaylistSorting, string> = { alphabetical: 'a', manual: 'm' };

function text(t: string) {
  return { content: [{ type: 'text', text: t }] };
}

function soundsOf(playlist: Rec): Rec[] {
  return (Array.isArray(playlist.sounds) ? playlist.sounds : []).filter(isRec);
}

function modeName(playlist: Rec): string {
  return MODE_NAMES.get(num(playlist.mode, 0)) ?? String(playlist.mode);
}

export function resolvePlaylist(snapshot: WorldData, ref: string): Rec {
  return resolveByRef(snapshot.playlists as Rec[], ref, 'playlist', 'foundry_audio list');
}

function resolveSound(playlist: Rec, ref: string): Rec {
  return resolveByRef(
    soundsOf(playlist),
    ref,
    `sound in "${str(playlist.name)}"`,
    'foundry_audio list',
  );
}

function isPlaying(playlist: Rec): boolean {
  return soundsOf(playlist).some((s) => s.playing === true);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export async function handleListAudio(
  args: { query?: string; playlist?: string; limit?: number; offset?: number },
  foundryClient: FoundryClient,
) {
  return withToolError('list audio', async () => {
    const snapshot = snapshotOf(foundryClient);
    const limit = args.limit ?? 25;

    if (args.playlist) {
      const playlist = resolvePlaylist(snapshot, args.playlist);
      const sounds = soundsOf(playlist);
      const rows = sounds.map(
        (s) =>
          `- **${str(s.name)}** \`${str(s._id)}\` — ${str(s.path) || 'no file'} · vol ${num(s.volume, 0.5)}${s.repeat === true ? ' · repeat' : ''}${s.playing === true ? ' · PLAYING' : ''}`,
      );
      return text(
        `🎵 **${str(playlist.name)}** \`${str(playlist._id)}\` — mode ${modeName(playlist)}, channel ${str(playlist.channel, 'music')}${isPlaying(playlist) ? ' · PLAYING' : ''}\n${rows.length > 0 ? rows.join('\n') : '_No sounds._'}`,
      );
    }

    const q = (args.query ?? '').toLowerCase();
    const all = (snapshot.playlists as Rec[]).filter(
      (p) =>
        !q ||
        str(p.name).toLowerCase().includes(q) ||
        soundsOf(p).some((s) => str(s.name).toLowerCase().includes(q)),
    );
    const page = pageSlice(all, limit, args.offset);
    const rows = page.items.map(
      (p) =>
        `- **${str(p.name)}** \`${str(p._id)}\` — ${soundsOf(p).length} sounds · ${modeName(p)}${isPlaying(p) ? ' · PLAYING' : ''}`,
    );
    return text(
      `🎵 **Playlists** (${all.length})\n${rows.length > 0 ? rows.join('\n') : '_None found._'}${page.footer}\n\n_Pass playlist to list its sounds with ids._`,
    );
  });
}

// ---------------------------------------------------------------------------
// play / stop
// ---------------------------------------------------------------------------

export async function handleAudioPlay(
  args: { playlist: string; sound?: string },
  foundryClient: FoundryClient,
) {
  return withToolError('play audio', async () => {
    const playlist = resolvePlaylist(snapshotOf(foundryClient), args.playlist);
    const id = str(playlist._id);
    const sounds = soundsOf(playlist);
    if (sounds.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, `Playlist "${str(playlist.name)}" has no sounds`);
    }
    const mode = num(playlist.mode, 0);
    let update: Rec;
    let what: string;

    if (args.sound) {
      const sound = resolveSound(playlist, args.sound);
      const sid = str(sound._id);
      update =
        mode === PLAYLIST_MODES.sequential || mode === PLAYLIST_MODES.shuffle
          ? {
              _id: id,
              playing: true,
              sounds: sounds.map((s) => ({
                _id: str(s._id),
                playing: s._id === sid,
                ...(s._id === sid ? {} : { pausedTime: null }),
              })),
            }
          : { _id: id, playing: true, sounds: [{ _id: sid, playing: true }] };
      what = `"${str(sound.name)}" in "${str(playlist.name)}"`;
    } else if (mode === PLAYLIST_MODES.disabled) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Playlist "${str(playlist.name)}" is a soundboard (mode disabled): pass sound to play one track, or set its mode with foundry_audio_edit update.`,
      );
    } else if (mode === PLAYLIST_MODES.simultaneous) {
      update = {
        _id: id,
        playing: true,
        sounds: sounds.map((s) => ({ _id: str(s._id), playing: true })),
      };
      what = `all ${sounds.length} sounds of "${str(playlist.name)}"`;
    } else {
      // Sequential / shuffle: resume a paused track, else the first in order.
      const paused = sounds.find((s) => num(s.pausedTime, 0) > 0);
      const ordered = [...sounds].sort((a, b) =>
        str(playlist.sorting, 'a') === 'm'
          ? num(a.sort) - num(b.sort)
          : str(a.name).localeCompare(str(b.name)),
      );
      const next = paused ?? ordered[0];
      update = {
        _id: id,
        playing: true,
        sounds: sounds.map((s) => ({ _id: str(s._id), playing: s._id === next?._id })),
      };
      what = `"${str(next?.name)}" in "${str(playlist.name)}"`;
    }

    await foundryClient.updateDocuments('Playlist', [update]);
    return text(`▶️ **Playing** ${what}`);
  });
}

export async function handleAudioStop(
  args: { playlist?: string; sound?: string },
  foundryClient: FoundryClient,
) {
  return withToolError('stop audio', async () => {
    const snapshot = snapshotOf(foundryClient);
    if (!args.playlist) {
      const playing = (snapshot.playlists as Rec[]).filter(isPlaying);
      if (playing.length === 0) {
        return text('⏹️ Nothing is playing.');
      }
      await foundryClient.updateDocuments(
        'Playlist',
        playing.map((p) => ({
          _id: str(p._id),
          playing: false,
          sounds: soundsOf(p).map((s) => ({ _id: str(s._id), playing: false })),
        })),
      );
      return text(`⏹️ **Stopped** ${playing.map((p) => `"${str(p.name)}"`).join(', ')}`);
    }

    const playlist = resolvePlaylist(snapshot, args.playlist);
    const id = str(playlist._id);
    if (args.sound) {
      const sound = resolveSound(playlist, args.sound);
      const others = soundsOf(playlist).some((s) => s._id !== sound._id && s.playing === true);
      await foundryClient.updateDocuments('Playlist', [
        {
          _id: id,
          playing: others,
          sounds: [{ _id: str(sound._id), playing: false, pausedTime: null }],
        },
      ]);
      return text(`⏹️ **Stopped** "${str(sound.name)}" in "${str(playlist.name)}"`);
    }
    await foundryClient.updateDocuments('Playlist', [
      {
        _id: id,
        playing: false,
        sounds: soundsOf(playlist).map((s) => ({ _id: str(s._id), playing: false })),
      },
    ]);
    return text(`⏹️ **Stopped** "${str(playlist.name)}"`);
  });
}

// ---------------------------------------------------------------------------
// create / add / update / delete
// ---------------------------------------------------------------------------

export async function handleCreatePlaylist(
  args: {
    name: string;
    description?: string;
    mode?: PlaylistModeName;
    channel?: AudioChannel;
    sorting?: PlaylistSorting;
    fade?: number;
    folder?: string;
  },
  foundryClient: FoundryClient,
) {
  return withToolError('create playlist', async () => {
    const snapshot = snapshotOf(foundryClient);
    const data: Rec = { name: args.name };
    if (args.description !== undefined) {
      data.description = args.description;
    }
    if (args.mode !== undefined) {
      data.mode = PLAYLIST_MODES[args.mode];
    }
    if (args.channel !== undefined) {
      data.channel = args.channel;
    }
    if (args.sorting !== undefined) {
      data.sorting = SORTING[args.sorting];
    }
    if (args.fade !== undefined) {
      data.fade = args.fade;
    }
    if (args.folder) {
      data.folder = resolveFolder(snapshot, args.folder, 'Playlist');
    }
    const [created] = await foundryClient.createDocuments('Playlist', [data]);
    return text(
      `🎵 **Playlist Created**\n**Name:** ${args.name}\n**ID:** ${str(created?._id)}\nAdd tracks with foundry_audio_edit add_sound.`,
    );
  });
}

export async function handleAddSound(
  args: {
    playlist: string;
    name: string;
    path: string;
    volume?: number;
    repeat?: boolean;
    channel?: AudioChannel;
    fade?: number;
    description?: string;
  },
  foundryClient: FoundryClient,
) {
  return withToolError('add sound', async () => {
    const playlist = resolvePlaylist(snapshotOf(foundryClient), args.playlist);
    const data: Rec = { name: args.name, path: args.path };
    if (args.volume !== undefined) {
      data.volume = args.volume;
    }
    if (args.repeat !== undefined) {
      data.repeat = args.repeat;
    }
    if (args.channel !== undefined) {
      data.channel = args.channel;
    }
    if (args.fade !== undefined) {
      data.fade = args.fade;
    }
    if (args.description !== undefined) {
      data.description = args.description;
    }
    const [created] = await foundryClient.createDocuments(
      'PlaylistSound',
      [data],
      `Playlist.${str(playlist._id)}`,
    );
    return text(
      `🎶 **Sound Added** to "${str(playlist.name)}"\n**Name:** ${args.name}\n**ID:** ${str(created?._id)}\n**File:** ${args.path}`,
    );
  });
}

export async function handleUpdateAudio(
  args: {
    playlist: string;
    sound?: string;
    name?: string;
    description?: string;
    mode?: PlaylistModeName;
    channel?: AudioChannel;
    sorting?: PlaylistSorting;
    fade?: number;
    path?: string;
    volume?: number;
    repeat?: boolean;
  },
  foundryClient: FoundryClient,
) {
  return withToolError('update audio', async () => {
    const playlist = resolvePlaylist(snapshotOf(foundryClient), args.playlist);
    const playlistName = str(playlist.name);
    const patch: Rec = {};
    const common = ['name', 'description', 'channel', 'fade'] as const;
    for (const k of common) {
      if (args[k] !== undefined) {
        patch[k] = args[k];
      }
    }

    if (args.sound) {
      const sound = resolveSound(playlist, args.sound);
      const soundName = str(sound.name);
      if (args.mode !== undefined || args.sorting !== undefined) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'mode and sorting belong to a playlist, not a sound',
        );
      }
      for (const k of ['path', 'volume', 'repeat'] as const) {
        if (args[k] !== undefined) {
          patch[k] = args[k];
        }
      }
      if (Object.keys(patch).length === 0) {
        throw new McpError(ErrorCode.InvalidParams, 'Give at least one field to change');
      }
      await foundryClient.updateDocuments(
        'PlaylistSound',
        [{ _id: str(sound._id), ...patch }],
        `Playlist.${str(playlist._id)}`,
      );
      return text(`✏️ **Sound Updated** "${soundName}": ${Object.keys(patch).join(', ')}`);
    }

    if (args.path !== undefined || args.volume !== undefined || args.repeat !== undefined) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'path, volume and repeat belong to a sound: pass sound to say which one',
      );
    }
    if (args.mode !== undefined) {
      patch.mode = PLAYLIST_MODES[args.mode];
    }
    if (args.sorting !== undefined) {
      patch.sorting = SORTING[args.sorting];
    }
    if (Object.keys(patch).length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'Give at least one field to change');
    }
    await foundryClient.updateDocuments('Playlist', [{ _id: str(playlist._id), ...patch }]);
    return text(`✏️ **Playlist Updated** "${playlistName}": ${Object.keys(patch).join(', ')}`);
  });
}

export async function handleDeleteAudio(
  args: { playlist: string; sound?: string },
  foundryClient: FoundryClient,
) {
  return withToolError('delete audio', async () => {
    const playlist = resolvePlaylist(snapshotOf(foundryClient), args.playlist);
    if (args.sound) {
      const sound = resolveSound(playlist, args.sound);
      await foundryClient.deleteDocuments(
        'PlaylistSound',
        [str(sound._id)],
        `Playlist.${str(playlist._id)}`,
      );
      return text(
        `🗑️ **Sound Deleted** "${str(sound.name)}" from "${str(playlist.name)}". Undo with foundry_history_edit undo.`,
      );
    }
    const count = soundsOf(playlist).length;
    await foundryClient.deleteDocuments('Playlist', [str(playlist._id)]);
    return text(
      `🗑️ **Playlist Deleted** "${str(playlist.name)}" and its ${count} sounds. Undo with foundry_history_edit undo.`,
    );
  });
}

// ---------------------------------------------------------------------------
// scene music
// ---------------------------------------------------------------------------

export async function handleSetSceneMusic(
  args: { scene: string; playlist?: string; sound?: string; clear?: boolean },
  foundryClient: FoundryClient,
) {
  return withToolError('set scene music', async () => {
    const snapshot = snapshotOf(foundryClient);
    const scene = resolveByRef(
      snapshot.scenes as unknown as Rec[],
      args.scene,
      'scene',
      'foundry_scenes search',
    );
    if (args.clear) {
      await foundryClient.updateDocuments('Scene', [
        { _id: str(scene._id), playlist: null, playlistSound: null },
      ]);
      return text(`🔇 **Scene Music Cleared** on "${str(scene.name)}"`);
    }
    if (!args.playlist) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Give playlist (and optionally sound), or clear=true',
      );
    }
    const playlist = resolvePlaylist(snapshot, args.playlist);
    const sound = args.sound ? resolveSound(playlist, args.sound) : null;
    await foundryClient.updateDocuments('Scene', [
      {
        _id: str(scene._id),
        playlist: str(playlist._id),
        playlistSound: sound ? str(sound._id) : null,
      },
    ]);
    return text(
      `🎼 **Scene Music Set** "${str(scene.name)}" → "${str(playlist.name)}"${sound ? ` / "${str(sound.name)}"` : ' (whole playlist)'}\nIt plays when the scene is activated.`,
    );
  });
}
