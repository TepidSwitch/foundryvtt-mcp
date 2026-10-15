/**
 * @fileoverview Effect tools: foundry_effects_edit (write)
 */

import { z } from 'zod';
import { action, DomainTool } from '../domain.js';
import { handleApplyStatusEffect } from '../handlers/token-mutations.js';

export const effectsEditTool = new DomainTool({
  name: 'foundry_effects_edit',
  title: 'Edit status effects',
  toolset: 'effects',
  write: true,
  destructive: true,
  description:
    'WRITE: apply or clear status conditions in the live world. Needs FOUNDRY_WRITE_ENABLED=true and a GM login.',
  actions: {
    apply_status: action({
      description:
        'Apply or remove a status condition (e.g. "prone", "stunned") on a token\'s actor; active=false removes it. Matches by status id, so re-applying or clearing an absent status is a no-op that reports success without writing. For HP or exhaustion use foundry_actors_edit update.',
      schema: z.object({
        tokenId: z.string().describe('Id of the token'),
        statusId: z.string().describe('Status id, e.g. "prone"'),
        active: z.boolean().optional().describe('true applies (default), false removes'),
        sceneId: z.string().optional().describe('Scene to look in (default: search all scenes)'),
      }),
      run: (a, ctx) => handleApplyStatusEffect(a, ctx.foundryClient),
    }),
  },
});
