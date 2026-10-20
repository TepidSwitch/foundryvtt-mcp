/**
 * Role-aware notes for the logged-in Foundry user. Pure rules over the role
 * number and the write gate, shared by the health report and the connect-time
 * log line so both say the same thing.
 */

import { USER_ROLE } from '../foundry/types.js';

export interface RoleNote {
  level: 'warn' | 'info';
  text: string;
}

export interface RoleAssessment {
  roleName: string;
  notes: RoleNote[];
}

const ROLE_NAMES: Record<number, string> = {
  1: 'Player',
  2: 'Trusted Player',
  3: 'Assistant GM',
  4: 'Game Master',
};

/**
 * What Foundry restricts for an Assistant GM (CONST.USER_ROLES.ASSISTANT),
 * from foundry.mjs: settings (BaseSetting #canModify), user creation
 * (User #canCreate), and GM-only permissions in USER_PERMISSIONS.
 */
export const ASSISTANT_GM_NOTE =
  'Foundry restricts some operations for Assistant GMs: settings outside a fixed list ' +
  'need the SETTINGS_MODIFY permission; they cannot create GM users or users with special ' +
  'permissions; FILES_UPLOAD, MACRO_SCRIPT and SETTINGS_MODIFY are always held by GMs and ' +
  'reach Assistants only per the world permission config.';

/**
 * Describes what the login's role means for the write tools. Returns null when
 * the role is unknown (not connected, or the user is not in the world snapshot).
 */
export function assessRole(role: number | null, writesEnabled: boolean): RoleAssessment | null {
  if (role === null) {
    return null;
  }
  const roleName = ROLE_NAMES[role] ?? `role ${role}`;
  const notes: RoleNote[] = [];

  if (role < USER_ROLE.ASSISTANT && writesEnabled) {
    notes.push({
      level: 'warn',
      text: `Login is ${roleName} (role ${role}) and FOUNDRY_WRITE_ENABLED is true: writes will be rejected; log in as a GM or Assistant GM.`,
    });
  } else if (role === USER_ROLE.ASSISTANT) {
    notes.push({ level: 'info', text: ASSISTANT_GM_NOTE });
  } else if (role === USER_ROLE.GAMEMASTER && !writesEnabled) {
    notes.push({
      level: 'info',
      text: 'Login is a Game Master, but FOUNDRY_WRITE_ENABLED is off: write tools are disabled.',
    });
  }

  return { roleName, notes };
}
