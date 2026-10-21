import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { clearBufferedLogs, pushLog } from '../../../utils/log-buffer.js';
import { handleDiagnoseErrors } from '../diagnostics.js';

const textOf = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? '';

describe('handleDiagnoseErrors', () => {
  afterEach(() => clearBufferedLogs());

  it('reports a clean buffer as nothing to fix', async () => {
    pushLog('info', 'connected');
    const text = textOf(await handleDiagnoseErrors({}));
    expect(text).toContain('**Errors:** 0 (0 distinct)');
    expect(text).toContain('Health score:** 100/100');
    expect(text).toContain('Nothing to fix.');
  });

  it('groups buffered errors by category with suggestions, newest first', async () => {
    pushLog('error', 'Socket.IO connection failed: ECONNREFUSED');
    pushLog('error', 'FoundryVTT rejected update Actor: no permission');
    pushLog('error', 'Socket.IO connection failed: ETIMEDOUT');
    pushLog('warn', 'slow world load');

    const text = textOf(await handleDiagnoseErrors({}));
    expect(text).toContain('**Errors:** 3 (3 distinct)');
    expect(text).toMatch(/\*\*connection:\*\* 2\n- \*\*write:\*\* 1/);
    expect(text.indexOf('ETIMEDOUT')).toBeLessThan(text.indexOf('ECONNREFUSED'));
    expect(text).toContain('FOUNDRY_WRITE_ENABLED');
    expect(text).toContain('Health score:** 70/100');
  });

  it('filters by category and rejects unknown ones', async () => {
    pushLog('error', 'Socket.IO connection failed: ECONNREFUSED');
    pushLog('error', 'FoundryVTT rejected update Actor: no permission');

    const text = textOf(await handleDiagnoseErrors({ category: 'write' }));
    expect(text).toContain('category write');
    expect(text).toContain('**Errors:** 1');
    expect(text).not.toContain('ECONNREFUSED');
    await expect(handleDiagnoseErrors({ category: 'nope' })).rejects.toThrow(McpError);
  });
});
