/**
 * Assembles a complete, named GraphQL operation document for a single root
 * field, passing every argument as a variable (so values are never inlined into
 * the query string — the executor's variable layer handles escaping/coercion).
 *
 * Example output for a `Mutation.createTodo(input: CreateTodoInput!)` field:
 *
 * ```graphql
 * mutation createTodo($input: CreateTodoInput!) {
 *   createTodo(input: $input) { id completed __typename }
 * }
 * ```
 */

import type { GraphQLField } from 'graphql';
import { buildSelectionSet } from './selection.ts';
import type { OperationKind } from './types.ts';

/** A built operation: the document plus the metadata needed to invoke it. */
export interface BuiltOperation {
  /** The operation document string. */
  query: string;
  /** The operation name (equal to the field name). */
  operationName: string;
  /** The field's argument names, in declared order. */
  argNames: string[];
}

/**
 * Builds the operation document for a root `field` of the given `kind`.
 *
 * @param kind - `'query'` or `'mutation'` — becomes the operation keyword.
 * @param field - The root field to wrap.
 * @param selectionDepth - Passed through to {@link buildSelectionSet} (default `2`).
 * @returns The {@link BuiltOperation}.
 */
export function buildOperation(
  kind: OperationKind,
  // biome-ignore lint/suspicious/noExplicitAny: a root field's source/context types are irrelevant here
  field: GraphQLField<any, any>,
  selectionDepth = 2,
): BuiltOperation {
  const variableDefs = field.args.map((arg) => `$${arg.name}: ${arg.type.toString()}`);
  const argPassings = field.args.map((arg) => `${arg.name}: $${arg.name}`);
  const varBlock = variableDefs.length ? `(${variableDefs.join(', ')})` : '';
  const argBlock = argPassings.length ? `(${argPassings.join(', ')})` : '';
  const selection = buildSelectionSet(field.type, selectionDepth);
  const selectionBlock = selection ? ` ${selection}` : '';
  const query = `${kind} ${field.name}${varBlock} {\n  ${field.name}${argBlock}${selectionBlock}\n}`;
  return { query, operationName: field.name, argNames: field.args.map((arg) => arg.name) };
}
