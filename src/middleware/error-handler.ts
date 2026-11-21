import type { ErrorRequestHandler } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../utils/app-error.js';

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  const appError = error instanceof AppError ? error : undefined;
  const statusCandidate =
    typeof error === 'object' && error !== null && 'status' in error
      ? error.status
      : undefined;
  const statusCode = appError?.statusCode ?? (typeof statusCandidate === 'number' ? statusCandidate : 500);
  const isClientError = statusCode >= 400 && statusCode < 500;
  const message = appError?.isOperational
    ? appError.message
    : isClientError && error instanceof SyntaxError
      ? 'Invalid JSON request body.'
      : 'Internal server error.';

  if (!appError && statusCode >= 500) {
    console.error('Unexpected request error:', error);
  }

  response.status(statusCode).json({
    success: false,
    error: {
      message,
      ...(appError?.code ? { code: appError.code } : {}),
      ...(env.NODE_ENV !== 'production' && appError ? { stack: appError.stack } : {}),
    },
  });
};
