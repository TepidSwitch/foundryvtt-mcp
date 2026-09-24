#!/usr/bin/env node

/**
 * Marks the built entry point executable (the cross-platform replacement for
 * `chmod +x dist/index.js` in the build script, which does not exist on
 * Windows). On Windows the permission bits are not meaningful, so a failure to
 * set them is ignored.
 */

import { chmodSync } from 'node:fs';

const target = process.argv[2] ?? 'dist/index.js';

try {
  chmodSync(target, 0o755);
} catch (error) {
  if (process.platform !== 'win32') {
    console.error(`Could not make ${target} executable:`, error.message);
    process.exit(1);
  }
}
