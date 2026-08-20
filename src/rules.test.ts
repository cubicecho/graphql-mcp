import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compileRules } from './rules.ts';

describe('compileRules', () => {
  test('a bare name matches the field on either root', () => {
    const matches = compileRules(['todos']);
    assert.equal(matches('todos', 'query'), true);
    assert.equal(matches('todos', 'mutation'), true);
    assert.equal(matches('todo', 'query'), false);
  });

  test('a Query./Mutation. prefix constrains the kind', () => {
    const matches = compileRules(['Query.todos']);
    assert.equal(matches('todos', 'query'), true);
    assert.equal(matches('todos', 'mutation'), false);
  });

  test('a wildcard after a prefix matches every field of that kind', () => {
    const matches = compileRules(['Mutation.*']);
    assert.equal(matches('createTodo', 'mutation'), true);
    assert.equal(matches('anything', 'mutation'), true);
    assert.equal(matches('createTodo', 'query'), false);
  });

  test('wildcards match within the field name', () => {
    const matches = compileRules(['delete*', 'Query.user*']);
    assert.equal(matches('deleteTodo', 'mutation'), true);
    assert.equal(matches('deleteAll', 'query'), true);
    assert.equal(matches('userById', 'query'), true);
    assert.equal(matches('userById', 'mutation'), false);
    assert.equal(matches('createTodo', 'mutation'), false);
  });

  test('a pattern without wildcards does not over-match', () => {
    const matches = compileRules(['todo']);
    assert.equal(matches('todos', 'query'), false);
  });

  test('regex metacharacters in patterns are inert', () => {
    const matches = compileRules(['to+dos']);
    assert.equal(matches('toodos', 'query'), false);
    assert.equal(matches('to+dos', 'query'), true);
  });

  test('an unknown prefix throws', () => {
    assert.throws(() => compileRules(['Foo.bar']), /invalid rule pattern 'Foo\.bar'/);
  });

  test('an empty pattern list never matches', () => {
    const matches = compileRules([]);
    assert.equal(matches('todos', 'query'), false);
  });
});
