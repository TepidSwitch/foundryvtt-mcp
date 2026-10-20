/**
 * @fileoverview Audio tools: foundry_audio (read), foundry_audio_edit (write)
 */

import { z } from 'zod';
import { action, DomainTool } from '../domain.js';
import {
  handleAddSound,
  handleAudioPlay,
  handleAudioStop,
  handleCreatePlaylist,
  handleDeleteAudio,
  handleListAudio,
  handleSetSceneMusic,
  handleUpdateAudio,
} from '../handlers/audio.js';

const playlist = z.string().describe('Playlist id or name (partial ok)');
const sound = z.string().optional().describe('Sound id or name within the playlist');
const mode = z
  .enum(['disabled', 'sequential', 'shuffle', 'simultaneous'])
  .optional()
  .describe('Playback mode: disabled = soundboard only, sequential, shuffle, simultaneous');
const channel = z.enum(['music', 'environment', 'interface']).optional().describe('Audio channel');
const sorting = z.enum(['alphabetical', 'manual']).optional().describe('Track order');

export const audioTool = new DomainTool({
  name: 'foundry_audio',
  title: 'Foundry audio',
  toolset: 'audio',
  write: false,
  description: 'Read playlists and their sounds.',
  actions: {
    list: action({
      description:
        'List playlists with sound counts, mode and whether they are playing; query matches playlist or sound names. Pass playlist to list its sounds with ids, files, volume and playing state.',
      schema: z.object({
        query: z
          .string()
          .optional()
          .describe('Only playlists whose name or a sound name contains this'),
        playlist: z.string().optional().describe('Show one playlist in detail (id or name)'),
        limit: z.number().optional().describe('Maximum playlists (default 25)'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Playlists to skip before the page (default 0)'),
      }),
      run: (a, ctx) => handleListAudio(a, ctx.foundryClient),
    }),
  },
});

export const audioEditTool = new DomainTool({
  name: 'foundry_audio_edit',
  title: 'Edit audio',
  toolset: 'audio',
  write: true,
  destructive: true,
  description:
    'WRITE: play and stop audio, and create or change playlists, sounds and scene music in the live world. Playback starts on every connected client, like clicking in the Playlists sidebar. Needs FOUNDRY_WRITE_ENABLED=true and a GM login; writes are logged and revertible with foundry_history_edit.',
  actions: {
    play: action({
      description:
        'Start a playlist, or one sound in it. Whole playlist: sequential/shuffle start one track (resuming a paused one), simultaneous starts all; a soundboard (disabled) playlist needs sound.',
      schema: z.object({ playlist, sound }),
      run: (a, ctx) => handleAudioPlay(a, ctx.foundryClient),
    }),
    stop: action({
      description:
        'Stop a sound, a whole playlist, or (with no playlist) everything that is playing.',
      schema: z.object({
        playlist: z
          .string()
          .optional()
          .describe('Playlist id or name; omit to stop all playing playlists'),
        sound,
      }),
      run: (a, ctx) => handleAudioStop(a, ctx.foundryClient),
    }),
    create_playlist: action({
      description: 'Create an empty playlist; add tracks with add_sound.',
      schema: z.object({
        name: z.string().describe('Playlist name'),
        description: z.string().optional().describe('Description'),
        mode,
        channel,
        sorting,
        fade: z.number().optional().describe('Crossfade in milliseconds'),
        folder: z.string().optional().describe('Existing Playlist folder (id or name)'),
      }),
      run: (a, ctx) => handleCreatePlaylist(a, ctx.foundryClient),
    }),
    add_sound: action({
      description:
        'Add a track to a playlist. path is a file in the Foundry data folder (upload one with foundry_files_edit) or a URL.',
      schema: z.object({
        playlist,
        name: z.string().describe('Track name'),
        path: z.string().describe('Audio file path or URL'),
        volume: z.number().min(0).max(1).optional().describe('Volume 0-1 (Foundry default 0.5)'),
        repeat: z.boolean().optional().describe('Loop the track'),
        channel,
        fade: z.number().optional().describe('Fade in milliseconds'),
        description: z.string().optional().describe('Description'),
      }),
      run: (a, ctx) => handleAddSound(a, ctx.foundryClient),
    }),
    update: action({
      description:
        'Change a playlist (name, description, mode, channel, sorting, fade) or, with sound set, one sound (name, description, channel, fade, path, volume, repeat).',
      schema: z.object({
        playlist,
        sound,
        name: z.string().optional().describe('New name'),
        description: z.string().optional().describe('New description'),
        mode,
        channel,
        sorting,
        fade: z.number().optional().describe('Fade in milliseconds'),
        path: z.string().optional().describe('Sound only: new audio file path or URL'),
        volume: z.number().min(0).max(1).optional().describe('Sound only: volume 0-1'),
        repeat: z.boolean().optional().describe('Sound only: loop the track'),
      }),
      run: (a, ctx) => handleUpdateAudio(a, ctx.foundryClient),
    }),
    delete: action({
      description:
        'Delete one sound, or (without sound) a whole playlist with all its sounds. Confirm with the user first; foundry_history_edit undo can re-create it.',
      schema: z.object({ playlist, sound }),
      run: (a, ctx) => handleDeleteAudio(a, ctx.foundryClient),
    }),
    set_scene_music: action({
      description:
        'Make a scene play a playlist (or one sound of it) when the scene is activated; clear=true removes the scene music.',
      schema: z.object({
        scene: z.string().describe('Scene id or name (partial ok)'),
        playlist: z.string().optional().describe('Playlist id or name'),
        sound,
        clear: z.boolean().optional().describe('Remove the scene music'),
      }),
      run: (a, ctx) => handleSetSceneMusic(a, ctx.foundryClient),
    }),
  },
});
