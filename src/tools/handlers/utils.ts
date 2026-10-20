/**
 * Shared utilities for tool handlers
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../../utils/logger.js';

/**
 * Wraps an async handler function with standard error logging and McpError conversion.
 *
 * @param toolName - Label used in error log messages (e.g. 'search actors')
 * @param fn - Async function containing the handler logic
 */
export async function withToolError<T>(toolName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    logger.error(`Failed to ${toolName}:`, error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to ${toolName}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Footer for one page of a list, or '' when the page holds the whole list.
 * `next offset` is omitted on the last page.
 */
export function pageFooter(total: number, offset: number, shown: number): string {
  if (offset === 0 && shown >= total) {
    return '';
  }
  if (shown === 0) {
    return `\n_No entries at offset ${offset}; ${total} total._`;
  }
  const end = offset + shown;
  const next = end < total ? `; next offset=${end}` : '';
  return `\n_Showing ${offset + 1}–${end} of ${total}${next}._`;
}

/** Takes one page of `items` starting at `offset`, with its footer. */
export function pageSlice<T>(
  items: readonly T[],
  limit: number,
  offset = 0,
): { items: T[]; footer: string } {
  const start = Math.max(Math.floor(offset), 0);
  const page = items.slice(start, start + limit);
  return { items: page, footer: pageFooter(items.length, start, page.length) };
}
