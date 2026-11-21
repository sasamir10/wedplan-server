import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedIdentity, AuthenticatedRole } from '../src/middleware/authenticate.js';
import { authorizeRoles } from '../src/middleware/authorize.js';
import { AppError } from '../src/utils/app-error.js';

const baseIdentity: AuthenticatedIdentity = {
  id: 'verified-user-id',
  email: 'verified@example.com',
  role: 'customer',
  isBlocked: false,
  issuedAt: 1_700_000_000,
  expiresAt: 1_700_000_900,
};

function runAuthorization(
  allowedRoles: AuthenticatedRole[],
  identity: unknown = baseIdentity,
  body: unknown = {},
) {
  let nextCalled = false;
  let forwardedError: unknown;
  const request = { authenticatedUser: identity, body } as Request;
  const next = ((error?: unknown) => {
    nextCalled = true;
    forwardedError = error;
  }) as NextFunction;

  authorizeRoles(...allowedRoles)(request, {} as Response, next);

  return { nextCalled, forwardedError };
}

function assertDenied(result: ReturnType<typeof runAuthorization>, statusCode: number) {
  assert.ok(result.forwardedError instanceof AppError);
  assert.equal(result.forwardedError.statusCode, statusCode);
  assert.equal(result.nextCalled, true);
}

test('allows a customer on a customer-only route', () => {
  const result = runAuthorization(['customer']);

  assert.equal(result.forwardedError, undefined);
  assert.equal(result.nextCalled, true);
});

test('denies a customer on an admin-only route', () => {
  assertDenied(runAuthorization(['admin']), 403);
});

test('denies a vendor on an admin-only route', () => {
  assertDenied(runAuthorization(['admin'], { ...baseIdentity, role: 'vendor' }), 403);
});

test('rejects unauthenticated access to an admin-only route', () => {
  assertDenied(runAuthorization(['admin'], null), 401);
});

test('allows a vendor on a vendor-only route', () => {
  const result = runAuthorization(['vendor'], {
    ...baseIdentity,
    role: 'vendor',
  });

  assert.equal(result.forwardedError, undefined);
  assert.equal(result.nextCalled, true);
});

test('denies a customer on a vendor-only route', () => {
  assertDenied(runAuthorization(['vendor']), 403);
});

test('denies a vendor on a customer-only route', () => {
  assertDenied(
    runAuthorization(['customer'], { ...baseIdentity, role: 'vendor' }),
    403,
  );
});

test('allows an admin on an admin-only route', () => {
  const result = runAuthorization(['admin'], {
    ...baseIdentity,
    role: 'admin',
  });

  assert.equal(result.forwardedError, undefined);
  assert.equal(result.nextCalled, true);
});

test('allows only the explicitly permitted roles in a multi-role policy', () => {
  const result = runAuthorization(['vendor', 'admin'], {
    ...baseIdentity,
    role: 'admin',
  });

  assert.equal(result.forwardedError, undefined);
  assert.equal(result.nextCalled, true);
});

test('returns 401 when verified identity is missing', () => {
  assertDenied(runAuthorization(['customer'], null), 401);
});

test('returns 403 for an unsupported verified role', () => {
  assertDenied(
    runAuthorization(['admin'], { ...baseIdentity, role: 'unknown' }),
    403,
  );
});

test('returns 403 when a verified identity has no role', () => {
  assertDenied(
    runAuthorization(['customer'], { ...baseIdentity, role: undefined }),
    403,
  );
});

test('ignores a client-supplied role in the request body', () => {
  assertDenied(
    runAuthorization(['admin'], baseIdentity, { role: 'admin' }),
    403,
  );
});
