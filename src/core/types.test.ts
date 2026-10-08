import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MutationHints, NameCase, NullBranches, OperationKind } from '../index.ts';

describe('closed-set objects', () => {
  test('each key holds the string an option accepts', () => {
    assert.deepEqual(OperationKind, { query: 'query', mutation: 'mutation' });
    assert.deepEqual(NullBranches, { always: 'always', never: 'never' });
    assert.deepEqual(NameCase, { snake: 'snake', preserve: 'preserve' });
    assert.deepEqual(MutationHints, { uniform: 'uniform', byName: 'byName' });
  });

  test('a member is assignable where the literal is', () => {
    const kind: OperationKind = OperationKind.mutation;
    const branches: NullBranches = 'never';
    assert.equal(kind, 'mutation');
    assert.equal(branches, NullBranches.never);
  });
});
