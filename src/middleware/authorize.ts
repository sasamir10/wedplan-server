import type { RequestHandler } from 'express';
import type { AuthenticatedRole } from './authenticate.js';
import { AppError } from '../utils/app-error.js';

/** Allows a request only when its verified identity has one of the listed roles. */
export function authorizeRoles(
  ...allowedRoles: AuthenticatedRole[]
): RequestHandler {
  return (request, _response, next) => {
    const authenticatedUser = request.authenticatedUser;

    if (!authenticatedUser) {
      return next(
        new AppError('Authentication required.', 401, true, 'AUTHENTICATION_REQUIRED'),
      );
    }

    const role: unknown = authenticatedUser.role;

    if (
      typeof role !== 'string' ||
      !allowedRoles.some((allowedRole) => allowedRole === role)
    ) {
      return next(
        new AppError(
          'You are not authorized to access this resource.',
          403,
          true,
          'ROLE_FORBIDDEN',
        ),
      );
    }

    return next();
  };
}
