import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildSchema } from 'graphql';
import { makeTodoSchema } from './fixtures.test.ts';
import { buildTools } from './tools.ts';

describe('buildTools', () => {
  test('creates one tool per query and mutation field', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema);
    const byName = new Map(tools.map((t) => [t.name, t]));
    assert.deepEqual([...byName.keys()].sort(), ['createTodo', 'setCompleted', 'todo', 'todos']);
  });

  test('carries SDL descriptions, signature, and args into the description', () => {
    const { schema } = makeTodoSchema();
    const createTodo = buildTools(schema).find((t) => t.name === 'createTodo');
    assert.ok(createTodo);
    assert.match(createTodo.description, /Create a new todo for a user\./);
    assert.match(createTodo.description, /GraphQL mutation: `createTodo` → `Todo!`/);
    assert.match(createTodo.description, /- `input`: `CreateTodoInput!`/);
  });

  test('annotations mark queries read-only and mutations destructive', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema);
    const todo = tools.find((t) => t.name === 'todo');
    const createTodo = tools.find((t) => t.name === 'createTodo');
    assert.equal(todo?.annotations.readOnlyHint, true);
    assert.equal(todo?.annotations.destructiveHint, false);
    assert.equal(createTodo?.annotations.readOnlyHint, false);
    assert.equal(createTodo?.annotations.destructiveHint, true);
  });

  test('humanizes the title', () => {
    const { schema } = makeTodoSchema();
    const createTodo = buildTools(schema).find((t) => t.name === 'createTodo');
    assert.equal(createTodo?.title, 'Create Todo');
  });

  test('respects includeQueries / includeMutations', () => {
    const { schema } = makeTodoSchema();
    const onlyMutations = buildTools(schema, { includeQueries: false });
    assert.deepEqual(onlyMutations.map((t) => t.kind).sort(), ['mutation', 'mutation']);
  });

  test('filter and toolName options are applied', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, {
      filter: (field) => field.name === 'todo',
      toolName: (field) => `q_${field.name}`,
    });
    assert.deepEqual(
      tools.map((t) => t.name),
      ['q_todo'],
    );
  });

  test('throws on a tool-name collision', () => {
    const schema = buildSchema(`
      type Query { ping: String }
      type Mutation { ping: String }
    `);
    assert.throws(() => buildTools(schema), /duplicate tool name 'ping'/);
  });
});
