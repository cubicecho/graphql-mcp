import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { messageOf, packageError } from './errors.ts';

describe('packageError', () => {
  test('prefixes the message and keeps the cause', () => {
    const cause = new Error('inner');
    const error = packageError('something broke', { cause });
    assert.equal(error.message, 'graphql-mcp: something broke');
    assert.equal(error.cause, cause);
  });
});

describe('messageOf', () => {
  test('reads an Error and stringifies a primitive', () => {
    assert.equal(messageOf(new Error('boom'), 'fallback'), 'boom');
    assert.equal(messageOf('plain text', 'fallback'), 'plain text');
    assert.equal(messageOf(42, 'fallback'), '42');
  });

  test('falls back when the thrown value says nothing', () => {
    assert.equal(messageOf(new Error(''), 'fallback'), 'fallback');
    assert.equal(messageOf({ code: 500 }, 'fallback'), 'fallback');
    assert.equal(messageOf('', 'fallback'), 'fallback');
  });
});
