import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildSchema } from 'graphql';
import { makeTodoSchema, setMcpExtensions } from './fixtures.test.ts';
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

  test('descriptors keep the document operation name when the tool is renamed', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, { toolName: (field) => `q_${field.name}` });
    const todo = tools.find((t) => t.name === 'q_todo');
    assert.equal(todo?.operationName, 'todo');
    assert.match(todo?.query ?? '', /^query todo/);
  });
});

describe('buildTools include/exclude rules', () => {
  test('include keeps only matching fields', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, { include: ['Query.*'] });
    assert.deepEqual(tools.map((t) => t.name).sort(), ['todo', 'todos']);
  });

  test('exclude drops matching fields and wins over include', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, { include: ['*'], exclude: ['set*', 'Query.todo'] });
    assert.deepEqual(tools.map((t) => t.name).sort(), ['createTodo', 'todos']);
  });

  test('rules compose with the filter callback (all must pass)', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, {
      include: ['todo*'],
      filter: (field) => field.name.endsWith('s'),
    });
    assert.deepEqual(
      tools.map((t) => t.name),
      ['todos'],
    );
  });

  test('an invalid rule prefix throws at build time', () => {
    const { schema } = makeTodoSchema();
    assert.throws(() => buildTools(schema, { exclude: ['Subscription.x'] }), /invalid rule/);
  });
});

describe('buildTools extensions.mcp metadata', () => {
  test('hidden skips the field', () => {
    const { schema } = makeTodoSchema();
    setMcpExtensions(schema, 'Mutation', 'setCompleted', { hidden: true });
    const names = buildTools(schema).map((t) => t.name);
    assert.ok(!names.includes('setCompleted'));
    assert.equal(names.length, 3);
  });

  test('name renames the tool and wins over the toolName option', () => {
    const { schema } = makeTodoSchema();
    setMcpExtensions(schema, 'Query', 'todo', { name: 'fetchTodo' });
    const tools = buildTools(schema, { toolName: (field) => `q_${field.name}` });
    const renamed = tools.find((t) => t.name === 'fetchTodo');
    assert.ok(renamed);
    assert.equal(renamed.operationName, 'todo');
    assert.ok(tools.find((t) => t.name === 'q_todos'));
  });

  test('title is reflected in the descriptor and annotations', () => {
    const { schema } = makeTodoSchema();
    setMcpExtensions(schema, 'Query', 'todo', { title: 'Fetch One Todo' });
    const todo = buildTools(schema).find((t) => t.name === 'todo');
    assert.equal(todo?.title, 'Fetch One Todo');
    assert.equal(todo?.annotations.title, 'Fetch One Todo');
  });

  test('description replaces; appendDescription appends after a blank line', () => {
    const { schema } = makeTodoSchema();
    setMcpExtensions(schema, 'Query', 'todo', { description: 'Replaced.' });
    setMcpExtensions(schema, 'Query', 'todos', { appendDescription: 'Prefer status filters.' });
    const tools = buildTools(schema);
    assert.equal(tools.find((t) => t.name === 'todo')?.description, 'Replaced.');
    const todos = tools.find((t) => t.name === 'todos');
    assert.match(todos?.description ?? '', /List every todo/);
    assert.match(todos?.description ?? '', /\n\nPrefer status filters\.$/);
  });

  test('annotations merge over the kind-derived defaults', () => {
    const { schema } = makeTodoSchema();
    setMcpExtensions(schema, 'Mutation', 'setCompleted', {
      annotations: { destructiveHint: false, idempotentHint: true },
    });
    const tool = buildTools(schema).find((t) => t.name === 'setCompleted');
    assert.equal(tool?.annotations.destructiveHint, false);
    assert.equal(tool?.annotations.idempotentHint, true);
    // Untouched defaults survive the merge.
    assert.equal(tool?.annotations.openWorldHint, true);
  });

  test('selectionDepth applies per field', () => {
    const { schema } = makeTodoSchema();
    setMcpExtensions(schema, 'Query', 'todo', { selectionDepth: 1 });
    const tools = buildTools(schema);
    const shallow = tools.find((t) => t.name === 'todo');
    const deep = tools.find((t) => t.name === 'todos');
    // Depth 1 stops before the nested `createdBy` user object.
    assert.ok(!shallow?.query.includes('createdBy'));
    assert.ok(deep?.query.includes('createdBy'));
  });
});

describe('buildTools decorate', () => {
  test('a partial patch merges onto the descriptor', () => {
    const { schema } = makeTodoSchema();
    const tools = buildTools(schema, {
      decorate: (descriptor, _field, kind) =>
        kind === 'mutation'
          ? { description: `${descriptor.description}\n\nAsk before writing.` }
          : undefined,
    });
    assert.match(
      tools.find((t) => t.name === 'createTodo')?.description ?? '',
      /Ask before writing\.$/,
    );
    assert.doesNotMatch(tools.find((t) => t.name === 'todo')?.description ?? '', /Ask before/);
  });

  test('decorate sees extensions-applied values and wins over them', () => {
    const { schema } = makeTodoSchema();
    setMcpExtensions(schema, 'Query', 'todo', { name: 'fetchTodo', title: 'From Extensions' });
    let seenName = '';
    const tools = buildTools(schema, {
      decorate: (descriptor) => {
        if (descriptor.name !== 'fetchTodo') return;
        seenName = descriptor.name;
        return { title: 'From Decorate' };
      },
    });
    assert.equal(seenName, 'fetchTodo');
    assert.equal(tools.find((t) => t.name === 'fetchTodo')?.title, 'From Decorate');
  });

  test('a rename collision introduced by decorate throws', () => {
    const { schema } = makeTodoSchema();
    assert.throws(
      () => buildTools(schema, { decorate: () => ({ name: 'same' }) }),
      /duplicate tool name 'same'/,
    );
  });
});
