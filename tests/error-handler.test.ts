import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { errorHandler } from '../src/middleware/error-handler.js';
import { AppError } from '../src/utils/app-error.js';

interface ErrorBody {
  success: boolean;
  error: {
    message: string;
    code?: string;
    stack?: string;
  };
}

function renderError(error: unknown): { statusCode: number; body: ErrorBody } {
  let statusCode = 0;
  let body: ErrorBody | undefined;

  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: ErrorBody) {
      body = payload;
      return this;
    },
  } as unknown as Response;

  errorHandler(
    error,
    {} as Request,
    response,
    (() => undefined) as NextFunction,
  );

  assert.ok(body);
  return { statusCode, body };
}

test('error responses include a machine-readable code when provided', () => {
  const { statusCode, body } = renderError(
    new AppError(
      'Vendor account is unavailable.',
      403,
      true,
      'VENDOR_ACCOUNT_UNAVAILABLE',
    ),
  );

  assert.equal(statusCode, 403);
  assert.equal(body.success, false);
  assert.equal(body.error.message, 'Vendor account is unavailable.');
  assert.equal(body.error.code, 'VENDOR_ACCOUNT_UNAVAILABLE');
});

test('error responses omit the code field when no code is supplied', () => {
  const { statusCode, body } = renderError(
    new AppError('Vendor subscription could not be verified.', 403),
  );

  assert.equal(statusCode, 403);
  assert.equal('code' in body.error, false);
});
