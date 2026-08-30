/**
 * The package's own version, read from `package.json` at load time.
 *
 * The MCP server advertises a version during `initialize`, and hardcoding it
 * meant semantic-release could bump `package.json` while every published server
 * kept announcing the version it shipped with. `createRequire` resolves
 * `../package.json` correctly both unbuilt (from `src/`) and built (from
 * `dist/`), and needs no `resolveJsonModule` — which `rootDir: ./src` would
 * reject anyway.
 */

import { createRequire } from 'node:module';

const requireJson = createRequire(import.meta.url);

/** This package's version, or `'0.0.0'` if `package.json` can't be read. */
export const VERSION: string = readVersion();

function readVersion(): string {
  try {
    const pkg = requireJson('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    // A bundler that inlined this module without the manifest alongside it.
    // A wrong-looking version is better than failing to start a server.
    return '0.0.0';
  }
}
