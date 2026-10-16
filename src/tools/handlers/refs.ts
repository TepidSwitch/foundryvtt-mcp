/**
 * @fileoverview Resolve a user-supplied reference (id or name) to a cached document
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FoundryClient } from '../../foundry/client.js';
import type { WorldData } from '../../foundry/types.js';
import { type Rec, str } from './dnd5e.js';

/** The cached world, or an error that tells the caller to wait for the connection. */
export function snapshotOf(foundryClient: FoundryClient): WorldData {
  const snapshot = foundryClient.getWorldSnapshot();
  if (!snapshot) {
    throw new McpError(ErrorCode.InternalError, 'Not connected — no world data available');
  }
  return snapshot;
}

/**
 * Finds one document by id, exact name, or unique partial name (in that order).
 *
 * @param docs - candidate documents
 * @param ref - id or name from the caller
 * @param label - singular noun for messages, e.g. "playlist"
 * @param hint - what to try when nothing matches, e.g. "foundry_audio list"
 */
export function resolveByRef<T extends Rec>(
  docs: readonly T[],
  ref: string,
  label: string,
  hint: string,
): T {
  const byId = docs.find((d) => d._id === ref);
  if (byId) {
    return byId;
  }
  const lower = ref.toLowerCase();
  const exact = docs.filter((d) => str(d.name).toLowerCase() === lower);
  if (exact.length === 1 && exact[0]) {
    return exact[0];
  }
  const partial = docs.filter((d) => str(d.name).toLowerCase().includes(lower));
  if (exact.length === 0 && partial.length === 1 && partial[0]) {
    return partial[0];
  }
  const ambiguous = exact.length > 1 ? exact : partial;
  if (ambiguous.length > 1) {
    const list = ambiguous
      .slice(0, 8)
      .map((d) => `${str(d.name)} (${str(d._id)})`)
      .join('; ');
    throw new McpError(
      ErrorCode.InvalidParams,
      `"${ref}" matches several ${label}s — be more specific or use an id: ${list}`,
    );
  }
  throw new McpError(ErrorCode.InvalidParams, `No ${label} matches "${ref}". Try ${hint}.`);
}
