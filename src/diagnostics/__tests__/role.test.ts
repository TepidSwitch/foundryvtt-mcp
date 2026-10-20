/**
 * @fileoverview Role x write-gate matrix for the logged-in Foundry user.
 */

import { describe, expect, it } from 'vitest';
import { ASSISTANT_GM_NOTE, assessRole } from '../role.js';

describe('assessRole', () => {
  it('returns null when the role is unknown (not connected or not listed)', () => {
    expect(assessRole(null, true)).toBeNull();
    expect(assessRole(null, false)).toBeNull();
  });

  it.each([1, 2])('warns when role %i has writes enabled', (role) => {
    const a = assessRole(role, true);
    expect(a?.notes).toHaveLength(1);
    expect(a?.notes[0]).toMatchObject({ level: 'warn' });
    expect(a?.notes[0]?.text).toContain('writes will be rejected; log in as a GM or Assistant GM');
  });

  it.each([1, 2])('is silent for role %i when writes are disabled', (role) => {
    expect(assessRole(role, false)?.notes).toEqual([]);
  });

  it('notes Assistant GM restrictions with writes enabled', () => {
    const a = assessRole(3, true);
    expect(a?.roleName).toBe('Assistant GM');
    expect(a?.notes).toEqual([{ level: 'info', text: ASSISTANT_GM_NOTE }]);
  });

  it('notes Assistant GM restrictions with writes disabled too', () => {
    expect(assessRole(3, false)?.notes).toEqual([{ level: 'info', text: ASSISTANT_GM_NOTE }]);
  });

  it('is silent for a GM with writes enabled', () => {
    const a = assessRole(4, true);
    expect(a?.roleName).toBe('Game Master');
    expect(a?.notes).toEqual([]);
  });

  it('notes that writes are off for a GM', () => {
    const a = assessRole(4, false);
    expect(a?.notes).toHaveLength(1);
    expect(a?.notes[0]).toMatchObject({ level: 'info' });
    expect(a?.notes[0]?.text).toContain('FOUNDRY_WRITE_ENABLED is off');
  });

  it('never emits a warn-level note for roles that can write', () => {
    for (const writes of [true, false]) {
      const levels = [3, 4].flatMap((r) => assessRole(r, writes)?.notes.map((n) => n.level) ?? []);
      expect(levels).not.toContain('warn');
    }
  });
});
