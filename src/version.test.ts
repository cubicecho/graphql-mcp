import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildSchema } from 'graphql';
import { createMcpServer } from './server.ts';
import { VERSION } from './version.ts';

const require = createRequire(import.meta.url);

describe('VERSION', () => {
  test('matches the version in package.json', () => {
    const pkg = JSON.parse(readFileSync(require.resolve('../package.json'), 'utf8'));
    assert.equal(VERSION, pkg.version);
  });

  test('is a semver string, not the read-failure fallback', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+/);
    assert.notEqual(VERSION, '0.0.0');
  });
});

/** Connects a client and returns what the server announced during `initialize`. */
async function announced(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'version-test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const info = client.getServerVersion();
  await client.close();
  return info;
}

describe('createMcpServer version', () => {
  const schema = buildSchema('type Query { a: String }');

  // A hardcoded default kept advertising the shipped version forever once
  // semantic-release started bumping package.json.
  test('advertises the package version to a connected client', async () => {
    const info = await announced(createMcpServer({ schema }));
    assert.equal(info?.version, VERSION);
  });

  test('an explicit version overrides it', async () => {
    const info = await announced(createMcpServer({ schema, version: '9.9.9' }));
    assert.equal(info?.version, '9.9.9');
  });
});
