import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { REPLAY_DEFAULTS, RESULT_DEFAULTS, SEARCH_DEFAULTS, SESSION_DEFAULTS, TOOL_DEFAULTS } from '../index.ts';

describe('defaults', () => {
  test('every group is frozen', () => {
    for (const group of [TOOL_DEFAULTS, RESULT_DEFAULTS, SEARCH_DEFAULTS, REPLAY_DEFAULTS, SESSION_DEFAULTS]) {
      assert.equal(Object.isFrozen(group), true);
    }
  });

  test('a write to a default is refused', () => {
    assert.throws(() => {
      (RESULT_DEFAULTS as { maxChars: number }).maxChars = 1;
    }, TypeError);
    assert.equal(RESULT_DEFAULTS.maxChars, 50_000);
  });
});
