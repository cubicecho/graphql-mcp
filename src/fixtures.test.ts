/**
 * Shared test fixture: a small "todos" schema (the example from the brief) built
 * as an executable schema via graphql-js's `buildSchema` + a resolver root, so
 * tests can run real operations with no extra dependencies. Nested fields
 * resolve through graphql-js's default field resolver (plain property access).
 *
 * This file is named `*.test.ts` only so it sits alongside the suites; it
 * registers no tests of its own.
 */

import { buildSchema, type GraphQLSchema } from 'graphql';

export const TODO_SDL = /* GraphQL */ `
  "A user in the system"
  type User {
    "The unique id for the user, a UUID"
    id: String!
    "The list of todos this user has created."
    todos: [Todo!]!
  }

  "A todo entity, able to be marked as completed"
  type Todo {
    "The unique id for the todo, a UUID"
    id: String!
    "If the todo is complete or not."
    completed: Boolean!
    "A textual description of what the todo is."
    description: String!
    "The user who created this todo."
    createdBy: User!
  }

  input CreateTodoInput {
    "Who the todo belongs to."
    userId: String!
    "What the todo is about."
    description: String!
  }

  enum TodoStatus {
    OPEN
    DONE
  }

  type Query {
    "Fetch a single todo by id."
    todo(id: String!): Todo
    "List every todo, optionally filtered by status."
    todos(status: TodoStatus): [Todo!]!
  }

  type Mutation {
    "Create a new todo for a user."
    createTodo(input: CreateTodoInput!): Todo!
    "Mark a todo completed (or not)."
    setCompleted(id: String!, completed: Boolean!): Todo
  }
`;

interface TodoRecord {
  id: string;
  completed: boolean;
  description: string;
  userId: string;
}

/** Builds the executable todo schema with an in-memory store seeded with `seed`. */
export function makeTodoSchema(seed: TodoRecord[] = defaultSeed()): {
  schema: GraphQLSchema;
  root: Record<string, unknown>;
  store: TodoRecord[];
} {
  const store = [...seed];
  const schema = buildSchema(TODO_SDL);

  const present = (todo: TodoRecord) => ({
    ...todo,
    createdBy: { id: todo.userId, todos: store.filter((t) => t.userId === todo.userId) },
  });

  const root = {
    todo: ({ id }: { id: string }) => {
      const found = store.find((t) => t.id === id);
      return found ? present(found) : null;
    },
    todos: ({ status }: { status?: string }) => {
      const filtered =
        status === 'DONE'
          ? store.filter((t) => t.completed)
          : status === 'OPEN'
            ? store.filter((t) => !t.completed)
            : store;
      return filtered.map(present);
    },
    createTodo: ({ input }: { input: { userId: string; description: string } }) => {
      const todo: TodoRecord = {
        id: `todo-${store.length + 1}`,
        completed: false,
        description: input.description,
        userId: input.userId,
      };
      store.push(todo);
      return present(todo);
    },
    setCompleted: ({ id, completed }: { id: string; completed: boolean }) => {
      const found = store.find((t) => t.id === id);
      if (!found) return null;
      found.completed = completed;
      return present(found);
    },
  };

  return { schema, root, store };
}

function defaultSeed(): TodoRecord[] {
  return [
    { id: 'todo-1', completed: false, description: 'write the wrapper', userId: 'user-1' },
    { id: 'todo-2', completed: true, description: 'read the brief', userId: 'user-1' },
  ];
}
