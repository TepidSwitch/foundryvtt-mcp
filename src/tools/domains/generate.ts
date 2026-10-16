/**
 * @fileoverview Generation tools: foundry_generate (read)
 */

import { z } from 'zod';
import { action, DomainTool } from '../domain.js';
import { handleGenerateLoot, handleGenerateNPC, handleLookupRule } from '../handlers/generation.js';
import { handleCancelMap, handleGenerateMap, handleMapStatus } from '../handlers/map-generation.js';

export const generateTool = new DomainTool({
  name: 'foundry_generate',
  title: 'Generate content',
  toolset: 'generate',
  write: false,
  description: 'Generate throwaway content as text. Nothing is created in Foundry.',
  actions: {
    npc: action({
      description:
        'Random NPC (name, race, class, HP, ability scores, background) as text. Creates no documents.',
      schema: z.object({
        level: z.number().min(1).max(20).optional().describe('NPC level 1-20 (default 1)'),
        race: z.string().optional().describe('Race'),
        class: z.string().optional().describe('Class'),
      }),
      run: (a, ctx) => handleGenerateNPC(a, ctx.foundryClient),
    }),
    loot: action({
      description:
        'Random treasure as text. Only the currency scales with challenge rating; the item list is fixed (a Healing Potion and a Silver Ring) and treasureType is accepted but unused. Creates no documents.',
      schema: z.object({
        challengeRating: z.number().min(0).max(30).optional().describe('Challenge rating 0-30'),
        treasureType: z.string().optional().describe('Accepted but unused'),
      }),
      run: (a, ctx) => handleGenerateLoot(a, ctx.foundryClient),
    }),
    map_status: action({
      description:
        'Progress of AI map generation jobs started with foundry_generate_edit map: queued, rendering, importing, done (with the scene id) or failed. Without job_id lists recent jobs. Only check when the user asks - the scene is created automatically when the render finishes.',
      schema: z.object({
        job_id: z.string().optional().describe('Job id from map; omit to list recent jobs'),
      }),
      run: (a, ctx) => handleMapStatus(a, ctx),
    }),
    rule: action({
      description:
        'Stub: builds a templated placeholder from the query and consults no rules source, so its text carries no rules content.',
      schema: z.object({
        query: z.string().describe('Rule to look up'),
        system: z.string().optional().describe('Game system'),
      }),
      run: (a, ctx) => handleLookupRule(a, ctx.foundryClient),
    }),
  },
});

export const generateEditTool = new DomainTool({
  name: 'foundry_generate_edit',
  title: 'Generate maps',
  toolset: 'generate',
  write: true,
  destructive: false,
  description:
    'WRITE: generate a battlemap with AI (ComfyUI + an SDXL D&D battlemap model) and import it as a new INACTIVE scene. Only adds a scene and an image file; nothing existing changes. Needs COMFYUI_URL, FOUNDRY_WRITE_ENABLED=true and a GM login. The render runs in the background; check foundry_generate map_status when asked.',
  actions: {
    map: action({
      description:
        'Start generating a map. prompt describes the place (it is wrapped with "2d DnD battlemap ... top-down view" for the model), so describe terrain, features and mood, not camera angles. scene_name should be short and evocative, e.g. "Harbor District" or "Moonlit Tavern". Returns a job id immediately.',
      schema: z.object({
        prompt: z
          .string()
          .describe('What the map shows, e.g. "a moonlit tavern courtyard with a well and stalls"'),
        scene_name: z.string().describe('Short, creative name for the new scene'),
        size: z
          .enum(['small', 'medium', 'large'])
          .optional()
          .describe('Image size: small 1024px, medium 1536px (default), large 2048px'),
        width: z.number().optional().describe('Exact width in pixels (512-2048, rounded to 64)'),
        height: z.number().optional().describe('Exact height in pixels (512-2048, rounded to 64)'),
        grid_size: z
          .number()
          .optional()
          .describe('Pixels per 5 ft square in the scene (default 70, min 50)'),
        quality: z
          .enum(['low', 'medium', 'high'])
          .optional()
          .describe('Render steps: low 8 (fast, default), medium 20, high 35'),
        seed: z.number().optional().describe('Seed to repeat a result'),
        folder: z
          .string()
          .optional()
          .describe('Existing Scene folder (id or name) for the new scene'),
      }),
      run: (a, ctx) => handleGenerateMap(a, ctx),
    }),
    cancel_map: action({
      description: 'Cancel a map job that is still queued or rendering.',
      schema: z.object({ job_id: z.string().describe('Job id from map') }),
      run: (a, ctx) => handleCancelMap(a, ctx),
    }),
  },
});
