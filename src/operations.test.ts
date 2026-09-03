/**
 * Covers `buildOperationTools` — the curated surface. The descriptors it
 * produces are the same shape `buildTools` produces, so the assertions here are
 * about the parts only a hand-written document has: comment-derived prose,
 * variable defaults, cross-file fragments, and the five boot-time refusals.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { buildSchema, parse, Source } from 'graphql';
import { z } from 'zod';
import { makeTodoSchema, TODO_FRAGMENTS, TODO_OPERATIONS } from './fixtures.test.ts';
import { buildOperationTools } from './operations.ts';
import type { ToolDescriptor } from './tools.ts';

/** The todos fixture with its hand-written documents. */
function todoOperations(options: Parameters<typeof buildOperationTools>[2] = {}): ToolDescriptor[] {
  const { schema } = makeTodoSchema();
  return buildOperationTools(schema, [TODO_OPERATIONS, TODO_FRAGMENTS], options);
}

/**
 * Whether the installed zod exposes `.meta()`. The JSON Schema `default`
 * keyword rides on it, so it is a v4-only affordance — on v3 a variable's
 * default is stated only in the prose, which is why the prose is asserted
 * unconditionally and the keyword only when it can exist.
 */
const HAS_META = typeof (z.string() as { meta?: unknown }).meta === 'function';

/** Finds one descriptor by tool name, failing loudly rather than returning undefined. */
function named(descriptors: ToolDescriptor[], name: string): ToolDescriptor {
  const found = descriptors.find((d) => d.name === name);
  assert.ok(found, `no descriptor named ${name} in ${descriptors.map((d) => d.name).join(', ')}`);
  return found;
}

/** A schema with a subscription root, a paging field, and an enum. */
const TASK_SDL = /* GraphQL */ `
  enum Status {
    OPEN
    DONE
  }
  type Task {
    id: ID!
    title: String!
  }
  type Query {
    tasks(limit: Int, offset: Int, status: Status): [Task!]!
    task(id: ID!): Task
  }
  type Mutation {
    deleteTask(id: ID!): Boolean!
  }
  type Subscription {
    taskAdded: Task!
  }
`;

/** Builds descriptors from one source over {@link TASK_SDL}. */
function tasks(
  document: string,
  options: Parameters<typeof buildOperationTools>[2] = {},
): ToolDescriptor[] {
  return buildOperationTools(buildSchema(TASK_SDL), new Source(document, 'ops.graphql'), options);
}

describe('buildOperationTools', () => {
  test('names a tool from the operation name, under nameCase', () => {
    assert.deepEqual(
      todoOperations()
        .map((d) => d.name)
        .sort(),
      ['add_todo', 'list_todos', 'one_todo'],
    );
    assert.deepEqual(
      todoOperations({ nameCase: 'preserve' })
        .map((d) => d.name)
        .sort(),
      ['addTodo', 'listTodos', 'oneTodo'],
    );
  });

  test('keeps the operation name separate from the tool name', () => {
    const tool = named(todoOperations(), 'list_todos');
    // The tool is `list_todos`; the document still says `listTodos`, and that is
    // the name the executor has to send as `operationName`.
    assert.equal(tool.operationName, 'listTodos');
    assert.equal(tool.title, 'List Todos');
    assert.match(tool.query, /^query listTodos\(/);
  });

  test('argNames are the declared variables, in declaration order', () => {
    const [tool] = tasks(`query listTasks($status: Status, $limit: Int) {
      tasks(status: $status, limit: $limit) { id }
    }`);
    assert.deepEqual(tool.argNames, ['status', 'limit']);
  });

  test('a query and a mutation get their kind and annotations', () => {
    const list = named(todoOperations(), 'list_todos');
    const add = named(todoOperations(), 'add_todo');
    assert.equal(list.kind, 'query');
    assert.equal(list.annotations.readOnlyHint, true);
    assert.equal(add.kind, 'mutation');
    assert.equal(add.annotations.readOnlyHint, false);
    assert.equal(add.annotations.destructiveHint, true);
  });

  test('mutationHints byName reads the operation name, not the field name', () => {
    // `deleteTask` is the field; the *author* named the operation `retireTask`,
    // and that choice is the better signal — so a `delete` field behind a
    // non-`delete` operation name is not claimed to be destructive-idempotent.
    const [chosen] = tasks(`mutation retireTask($id: ID!) { deleteTask(id: $id) }`, {
      mutationHints: 'byName',
    });
    assert.equal(chosen.annotations.idempotentHint, false);
    const [conventional] = tasks(`mutation deleteTask($id: ID!) { deleteTask(id: $id) }`, {
      mutationHints: 'byName',
    });
    assert.equal(conventional.annotations.idempotentHint, true);
  });

  test('each descriptor carries its own transitive fragments', () => {
    const list = named(todoOperations(), 'list_todos');
    const add = named(todoOperations(), 'add_todo');
    // `separateOperations` collects what this operation reaches, and only that:
    // the mutation never spreads `TodoFields`, so it must not carry it.
    assert.match(list.query, /fragment TodoFields on Todo/);
    assert.doesNotMatch(add.query, /fragment TodoFields/);
  });

  test('a fragment may live in a source of its own', () => {
    // The two sources are merged before validation, so this resolves. Passing
    // the operations alone must not — that is what proves the merge is load
    // bearing rather than incidental.
    const { schema } = makeTodoSchema();
    assert.throws(
      () => buildOperationTools(schema, TODO_OPERATIONS),
      /Unknown fragment "TodoFields"/,
    );
  });

  test('an unused fragment is allowed, because a shared fragment file has some', () => {
    const { schema } = makeTodoSchema();
    const spare = new Source('fragment Unused on Todo { completed }', 'spare.graphql');
    const built = buildOperationTools(schema, [TODO_OPERATIONS, TODO_FRAGMENTS, spare]);
    assert.equal(built.length, 3);
  });

  test('a non-null variable with a default is optional, and still advertises it', () => {
    // `$limit: Int! = 10` means "you may omit it; it is never null". Requiring
    // it would make an agent send a value the document already chose.
    const [tool] = tasks(`query listTasks($limit: Int! = 10) { tasks(limit: $limit) { id } }`);
    assert.equal(z.object(tool.inputSchema).safeParse({}).success, true);
    assert.match(tool.description, /omit for the default `10`/);
    const rendered = JSON.stringify(toJsonSchemaCompat(z.object(tool.inputSchema)));
    assert.doesNotMatch(rendered, /"required"/);
    if (HAS_META) assert.match(rendered, /"default":10/);
  });

  test('a non-null variable without a default stays required', () => {
    const [tool] = tasks(`query oneTask($id: ID!) { task(id: $id) { id } }`);
    assert.equal(z.object(tool.inputSchema).safeParse({}).success, false);
  });

  test('an enum default renders as its SDL name, not its internal value', () => {
    const [tool] = tasks(`query listTasks($status: Status = OPEN) {
      tasks(status: $status) { id }
    }`);
    assert.match(tool.description, /omit for the default `OPEN`/);
    if (HAS_META) {
      assert.match(
        JSON.stringify(toJsonSchemaCompat(z.object(tool.inputSchema))),
        /"default":"OPEN"/,
      );
    }
  });

  test('nullBranches never drops the explicit-null branch, and the prose with it', () => {
    const document = `query listTasks($status: Status = OPEN) {
      tasks(status: $status) { id }
    }`;
    const [always] = tasks(document);
    const [never] = tasks(document, { nullBranches: 'never' });
    assert.match(JSON.stringify(toJsonSchemaCompat(z.object(always.inputSchema))), /"null"/);
    assert.doesNotMatch(JSON.stringify(toJsonSchemaCompat(z.object(never.inputSchema))), /"null"/);
    // The prose has to move with the schema: warning about an explicit `null`
    // that the schema now rejects describes a call nobody can make.
    assert.match(always.description, /an explicit `null` is sent as null/);
    assert.doesNotMatch(never.description, /explicit `null`/);
  });

  test('a per-type mode carries over, unlike a per-field callback', () => {
    // The whole reason `{ byType }` survives the trip into `buildOperationTools`
    // where `(field, kind) => ...` cannot: it is keyed on the input type, so it
    // has nothing to ask about the root field an operation lacks.
    const document = `query listTasks($status: Status = OPEN, $limit: Int) {
      tasks(status: $status, limit: $limit) { id }
    }`;
    const [tool] = tasks(document, {
      nullBranches: { byType: (type) => (type.name === 'Status' ? 'never' : 'always') },
    });
    const rendered = JSON.stringify(toJsonSchemaCompat(z.object(tool.inputSchema)));
    assert.doesNotMatch(rendered, /"status":\{"anyOf"/);
    assert.match(rendered, /"limit":\{"anyOf"/);
    // The prose is resolved per argument from the same setting.
    assert.doesNotMatch(tool.description, /`OPEN`; an explicit `null`/);
  });

  test('a paging operation gets the same truncation hint a field would', () => {
    const [tool] = tasks(`query listTasks($limit: Int, $offset: Int) {
      tasks(limit: $limit, offset: $offset) { id }
    }`);
    assert.match(tool.pageHint ?? '', /`limit` to cap the page size/);
    const [none] = tasks(`query listTasks { tasks { id } }`);
    assert.equal(none.pageHint, undefined);
  });

  test('an input variable gets the same shape example a field argument gets', () => {
    const tool = named(todoOperations(), 'add_todo');
    const [, json] = /shape: (.+)/.exec(tool.description) ?? [];
    assert.ok(json, `no shape example in:\n${tool.description}`);
    // The strongest assertion available: the example the prose shows has to
    // satisfy the schema the tool advertises.
    assert.equal(tool.inputSchema.input.safeParse(JSON.parse(json)).success, true);
  });

  test('exampleDepth 0 omits the examples', () => {
    const { schema } = makeTodoSchema();
    const built = buildOperationTools(schema, [TODO_OPERATIONS, TODO_FRAGMENTS], {
      exampleDepth: 0,
    });
    assert.doesNotMatch(named(built, 'add_todo').description, /shape:/);
  });

  test('the description ends with the operation it will run', () => {
    const tool = named(todoOperations(), 'one_todo');
    assert.match(tool.description, /Runs this operation \(written by hand/);
    assert.ok(
      tool.description.includes(tool.query),
      'the printed query is not in the description verbatim',
    );
  });
});

describe('buildOperationTools comment attachment', () => {
  test("an operation's leading comment block becomes its summary", () => {
    const tool = named(todoOperations(), 'list_todos');
    assert.equal(
      tool.description.split('\n').slice(0, 2).join('\n'),
      'List every todo on the board.\nPass `status` to narrow it.',
    );
  });

  test("a variable's leading comment becomes its argument prose", () => {
    // The one thing GraphQL gives an operation no syntax for at all.
    assert.match(named(todoOperations(), 'list_todos').description, /— Only todos in this state\./);
  });

  test('an operation with no comment falls back to a generic summary', () => {
    assert.equal(
      named(todoOperations(), 'one_todo').description.split('\n')[0],
      'The `oneTodo` query.',
    );
  });

  test('a blank line ends the block, so a file header is not captured', () => {
    const [tool] = tasks(`# Everything this file is about.

# The real doc.
query listTasks { tasks { id } }`);
    assert.equal(tool.description.split('\n')[0], 'The real doc.');
    assert.doesNotMatch(tool.description, /Everything this file is about/);
  });

  test("a comment on someone else's line is not stolen by the next operation", () => {
    const [, second] = tasks(`query listTasks { tasks { id } } # a note about listTasks
query oneTask($id: ID!) { task(id: $id) { id } }`);
    assert.equal(second.description.split('\n')[0], 'The `oneTask` query.');
  });

  test('a document parsed with noLocation still builds, without prose', () => {
    // The token chain is a lexer detail, not part of graphql-js's documented
    // surface. Losing it must degrade to a working tool, never to a crash.
    const schema = buildSchema(TASK_SDL);
    const [tool] = buildOperationTools(
      schema,
      parse('# The real doc.\nquery listTasks { tasks { id } }', { noLocation: true }),
    );
    assert.equal(tool.description.split('\n')[0], 'The `listTasks` query.');
  });
});

describe('buildOperationTools refusals', () => {
  test('a syntax error names the file and position', () => {
    assert.throws(
      () => tasks('query listTasks { tasks { id '),
      (error: Error) => {
        assert.match(error.message, /^graphql-mcp: could not parse/);
        assert.match(error.message, /\(ops\.graphql:1:\d+\)/);
        return true;
      },
    );
  });

  test('a validation error names the file, the position, and the fix', () => {
    assert.throws(
      () => tasks('query listTasks { tasks { titel } }'),
      (error: Error) => {
        assert.match(error.message, /failed to validate against the schema/);
        assert.match(error.message, /Did you mean "title"/);
        assert.match(error.message, /\(ops\.graphql:1:\d+\)/);
        return true;
      },
    );
  });

  test('a duplicate operation name is a validation error, not a silent overwrite', () => {
    assert.throws(
      () => tasks('query a { tasks { id } } query a { tasks { title } }'),
      /There can be only one operation named "a"/,
    );
  });

  test('an anonymous operation is refused, because a tool is addressed by name', () => {
    assert.throws(
      () => tasks('{ tasks { id } }'),
      (error: Error) => {
        assert.match(error.message, /anonymous operation \(ops\.graphql:1:1\)/);
        return true;
      },
    );
  });

  test('a subscription is refused on this surface too', () => {
    assert.throws(
      () => tasks('subscription watch { taskAdded { id } }'),
      /the subscription `watch` \(ops\.graphql:1:1\) cannot become a tool/,
    );
  });

  test('sources that define no operation at all are refused', () => {
    // The bad-glob case: it would otherwise boot a server with no tools and no
    // hint about why.
    assert.throws(
      () => tasks('fragment Spare on Task { id }'),
      /none of them defined an operation/,
    );
  });

  test('no operations configured at all is not an error', () => {
    assert.deepEqual(buildOperationTools(buildSchema(TASK_SDL), []), []);
  });
});
