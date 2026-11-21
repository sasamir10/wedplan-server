import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { RequestHandler } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../utils/app-error.js';

export type AuthenticatedRole = 'customer' | 'vendor' | 'admin';

export interface AuthenticatedIdentity {
  id: string;
  email: string;
  role: AuthenticatedRole;
  isBlocked: boolean;
  issuedAt: number;
  expiresAt: number;
}

declare global {
  namespace Express {
    interface Request {
      authenticatedUser?: AuthenticatedIdentity;
    }
  }
}

const jwks = createRemoteJWKSet(
  new URL('/api/auth/jwks', env.BETTER_AUTH_URL),
);

// Authorization claims are a snapshot and may remain stale until the 15-minute token expires.

function isAuthenticatedRole(value: unknown): value is AuthenticatedRole {
  return value === 'customer' || value === 'vendor' || value === 'admin';
}

function isAuthenticatedPayload(payload: {
  sub?: unknown;
  email?: unknown;
  role?: unknown;
  isBlocked?: unknown;
  iat?: unknown;
  exp?: unknown;
}): payload is {
  sub: string;
  email: string;
  role: AuthenticatedRole;
  isBlocked: boolean;
  iat: number;
  exp: number;
} {
  return (
    typeof payload.sub === 'string' &&
    payload.sub.length > 0 &&
    typeof payload.email === 'string' &&
    payload.email.length > 0 &&
    isAuthenticatedRole(payload.role) &&
    typeof payload.isBlocked === 'boolean' &&
    typeof payload.iat === 'number' &&
    typeof payload.exp === 'number'
  );
}

export const authenticate: RequestHandler = async (request, _response, next) => {
  const match = /^Bearer\s+([^\s]+)$/i.exec(
    request.get('authorization')?.trim() ?? '',
  );
  const token = match?.[1];

  if (!token) {
    return next(
      new AppError('Authentication required.', 401, true, 'AUTHENTICATION_REQUIRED'),
    );
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: env.BETTER_AUTH_URL,
      audience: env.BETTER_AUTH_URL,
      algorithms: ['EdDSA'],
      maxTokenAge: '15m',
      clockTolerance: 5,
    });

    if (!isAuthenticatedPayload(payload)) {
      return next(new AppError('Invalid or expired access token.', 401));
    }

    if (payload.isBlocked) {
      return next(
        new AppError('Account access is unavailable.', 403, true, 'ACCOUNT_BLOCKED'),
      );
    }

    request.authenticatedUser = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      isBlocked: payload.isBlocked,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };

    return next();
  } catch {
    return next(new AppError('Invalid or expired access token.', 401));
  }
};
