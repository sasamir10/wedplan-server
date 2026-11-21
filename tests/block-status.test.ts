import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId, type Db } from 'mongodb';
import type { Request } from 'express';
import { enforceBlockStatus } from '../src/middleware/block-status.js';
import { AppError } from '../src/utils/app-error.js';

type MemoryUser = { _id: ObjectId; isBlocked: boolean };

function createDatabase(users: MemoryUser[]): Db {
  const collection = {
    findOne: async (filter: Record<string, unknown>) => {
      const user = users.find(
        (u) => u._id instanceof ObjectId && filter._id instanceof ObjectId && u._id.equals(filter._id),
      );
      return user ?? null;
    },
  } as unknown as ReturnType<Db['collection']>;

  return { collection: () => collection } as unknown as Db;
}

function runMiddleware(
  database: Db,
  authenticatedUser: { id: string } | undefined,
) {
  let nextCalled = false;
  let forwardedError: unknown;
  const request = {
    authenticatedUser,
  } as unknown as Request;
  const next = ((error?: unknown) => {
    nextCalled = true;
    forwardedError = error;
  }) as (error?: unknown) => void;

  const run = async (): Promise<{ nextCalled: boolean; forwardedError: unknown }> => {
    const handler = enforceBlockStatus(database);
    await handler(request, {} as never, next);
    return { nextCalled, forwardedError };
  };

  return { run };
}

function assertError(
  result: { nextCalled: boolean; forwardedError: unknown },
  statusCode: number,
  code: string,
) {
  assert.ok(result.nextCalled);
  assert.ok(result.forwardedError instanceof AppError);
  assert.equal((result.forwardedError as AppError).statusCode, statusCode);
  assert.equal((result.forwardedError as AppError).code, code);
}

test('returns 401 AUTHENTICATION_REQUIRED when no authenticated user', async () => {
  const database = createDatabase([]);
  const { run } = runMiddleware(database, undefined);
  const result = await run();
  assertError(result, 401, 'AUTHENTICATION_REQUIRED');
});

test('returns 403 INVALID_USER_ID when id is not a valid ObjectId hex', async () => {
  const database = createDatabase([]);
  const { run } = runMiddleware(database, { id: 'not-a-valid-id' });
  const result = await run();
  assertError(result, 403, 'INVALID_USER_ID');
});

test('returns 403 USER_NOT_FOUND when user is missing from the database', async () => {
  const database = createDatabase([]);
  const { run } = runMiddleware(database, { id: new ObjectId().toHexString() });
  const result = await run();
  assertError(result, 403, 'USER_NOT_FOUND');
});

test('returns 403 ACCOUNT_BLOCKED when the user is blocked', async () => {
  const blockedUserId = new ObjectId();
  const database = createDatabase([{ _id: blockedUserId, isBlocked: true }]);
  const { run } = runMiddleware(database, { id: blockedUserId.toHexString() });
  const result = await run();
  assertError(result, 403, 'ACCOUNT_BLOCKED');
});

test('calls next when the user is unblocked', async () => {
  const unblockedUserId = new ObjectId();
  const database = createDatabase([{ _id: unblockedUserId, isBlocked: false }]);
  const { run } = runMiddleware(database, { id: unblockedUserId.toHexString() });
  const result = await run();
  assert.equal(result.nextCalled, true);
  assert.equal(result.forwardedError, undefined);
});

test('calls next when isBlocked is undefined', async () => {
  const userId = new ObjectId();
  const database = createDatabase([{ _id: userId, isBlocked: undefined } as unknown as MemoryUser]);
  const { run } = runMiddleware(database, { id: userId.toHexString() });
  const result = await run();
  assert.equal(result.nextCalled, true);
  assert.equal(result.forwardedError, undefined);
});
