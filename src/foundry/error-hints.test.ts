import { describe, expect, it } from 'vitest';
import { explainConnectionError } from './error-hints.js';

describe('explainConnectionError', () => {
  it('keeps the raw message and appends a hint', () => {
    const out = explainConnectionError('No session cookie returned from /join');
    expect(out).toContain('No session cookie returned from /join');
    expect(out).toContain('world is probably stopped');
  });
  it('maps known join failures', () => {
    expect(
      explainConnectionError('authentication failed (HTTP 401): JOIN.ErrorUserDoesNotExist'),
    ).toContain('FOUNDRY_USERNAME');
    expect(
      explainConnectionError('HTTP 400 {"error":"The request could not be processed."}'),
    ).toContain('Origin');
    expect(explainConnectionError('connect ECONNREFUSED 1.2.3.4:443')).toContain('FOUNDRY_URL');
  });
  it('passes unknown errors through unchanged', () => {
    expect(explainConnectionError('weird')).toBe('weird');
  });
});
