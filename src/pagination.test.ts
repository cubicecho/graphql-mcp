/**
 * Covers paging-argument detection and the sentence it produces. The heuristic
 * is name-based, so the risks are a convention going unrecognised and an
 * unrelated argument being mistaken for one — both exercised here.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildSchema, type GraphQLArgument, type GraphQLObjectType } from 'graphql';
import { detectPagination, paginationHint } from './pagination.ts';

/** The arguments of `Query.field` in a one-field schema with the given argument SDL. */
function argsOf(argSdl: string): readonly GraphQLArgument[] {
  const schema = buildSchema(`type Query { field${argSdl ? `(${argSdl})` : ''}: [String!]! }`);
  const query = schema.getQueryType() as GraphQLObjectType;
  return query.getFields().field.args;
}

describe('detectPagination', () => {
  test('recognises the Relay convention', () => {
    assert.deepEqual(detectPagination(argsOf('first: Int, after: String')), {
      limit: 'first',
      next: 'after',
      style: 'cursor',
    });
  });

  test('recognises offset paging', () => {
    assert.deepEqual(detectPagination(argsOf('limit: Int, offset: Int')), {
      limit: 'limit',
      next: 'offset',
      style: 'offset',
    });
  });

  test('recognises take/skip', () => {
    assert.deepEqual(detectPagination(argsOf('take: Int, skip: Int')), {
      limit: 'take',
      next: 'skip',
      style: 'offset',
    });
  });

  test('recognises page numbers', () => {
    assert.deepEqual(detectPagination(argsOf('page: Int, pageSize: Int')), {
      limit: 'pageSize',
      next: 'page',
      style: 'page',
    });
  });

  test('matches case-insensitively but reports the argument as written', () => {
    assert.deepEqual(detectPagination(argsOf('PerPage: Int, Page: Int')), {
      limit: 'PerPage',
      next: 'Page',
      style: 'page',
    });
  });

  test('reports a limiter with no way to advance', () => {
    assert.deepEqual(detectPagination(argsOf('first: Int')), {
      limit: 'first',
      style: 'cursor',
    });
  });

  test('reports a cursor with no limiter', () => {
    assert.deepEqual(detectPagination(argsOf('after: String')), {
      next: 'after',
      style: 'cursor',
    });
  });

  test('prefers the highest-priority convention when a schema mixes them', () => {
    // `first`/`after` wins over the `limit` also present, rather than emitting
    // a hint that pairs arguments from two different conventions.
    assert.deepEqual(detectPagination(argsOf('first: Int, after: String, limit: Int')), {
      limit: 'first',
      next: 'after',
      style: 'cursor',
    });
  });

  test('ignores fields with no arguments', () => {
    assert.equal(detectPagination(argsOf('')), undefined);
  });

  test('does not mistake ordinary arguments for paging', () => {
    assert.equal(
      detectPagination(argsOf('id: String!, status: String, orderBy: String')),
      undefined,
    );
  });
});

describe('paginationHint', () => {
  test('names both arguments and what advancing means', () => {
    assert.equal(
      paginationHint(argsOf('first: Int, after: String')),
      'This field paginates: pass `first` to cap the page size, then `after` to continue from where this page ended.',
    );
  });

  test('phrases offset paging as skipping', () => {
    assert.match(paginationHint(argsOf('limit: Int, offset: Int')) ?? '', /skip past the items/);
  });

  test('phrases page paging as stepping', () => {
    assert.match(paginationHint(argsOf('page: Int, perPage: Int')) ?? '', /step to the next page/);
  });

  test('drops the second clause when there is only a limiter', () => {
    assert.equal(
      paginationHint(argsOf('first: Int')),
      'This field paginates: pass `first` to cap the page size.',
    );
  });

  test('is undefined for a field that does not paginate', () => {
    assert.equal(paginationHint(argsOf('id: String!')), undefined);
  });
});
