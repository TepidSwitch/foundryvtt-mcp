/**
 * Tools module entry point
 */

import { ALL_DOMAIN_TOOLS, COMFYUI_TOOLS } from './domains/index.js';
import { type RegistryOptions, ToolRegistry } from './registry.js';

export { handleReadResource as routeResourceRequest } from './handlers/resources.js';
export { DEFAULT_TOOLSETS, parseToolsets, ToolRegistry } from './registry.js';
export { getAllResources } from './resources.js';

/**
 * Build the registry with every domain tool registered; the options decide
 * which of them are exposed.
 */
export function createToolRegistry(options: RegistryOptions & { comfyui?: boolean }): ToolRegistry {
  const registry = new ToolRegistry(options);
  for (const tool of ALL_DOMAIN_TOOLS) {
    registry.register(tool);
  }
  if (options.comfyui) {
    for (const tool of COMFYUI_TOOLS) {
      registry.register(tool);
    }
  }
  return registry;
}
