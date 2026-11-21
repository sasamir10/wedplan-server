import type { RequestHandler } from 'express';
import type { Db } from 'mongodb';
import { AppError } from '../utils/app-error.js';
import { toBetterAuthUserObjectId } from '../utils/object-id.js';

function userCollection(database: Db) {
  return database.collection('user');
}

/**
 * Enforces blocked-user status against the current server-side user record,
 * not just the (potentially stale) JWT claim. This ensures blocking takes
 * effect immediately for already-authenticated users without requiring
 * them to sign out first.
 */
export function enforceBlockStatus(database: Db): RequestHandler {
  return async (request, _response, next) => {
    const authenticatedUser = request.authenticatedUser;

    if (!authenticatedUser) {
      return next(
        new AppError('Authentication required.', 401, true, 'AUTHENTICATION_REQUIRED'),
      );
    }

    const userObjectId = toBetterAuthUserObjectId(authenticatedUser.id);

    if (!userObjectId) {
      return next(
        new AppError('Invalid user identifier.', 403, true, 'INVALID_USER_ID'),
      );
    }

    const user = await userCollection(database).findOne(
      { _id: userObjectId },
      { projection: { isBlocked: 1, _id: 0 } },
    );

    if (!user) {
      return next(
        new AppError('User account not found.', 403, true, 'USER_NOT_FOUND'),
      );
    }

    if (user.isBlocked === true) {
      return next(
        new AppError('Account access is unavailable.', 403, true, 'ACCOUNT_BLOCKED'),
      );
    }

    return next();
  };
}
