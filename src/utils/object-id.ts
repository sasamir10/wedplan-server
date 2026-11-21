import { ObjectId } from 'mongodb';
import { AppError } from './app-error.js';

const OBJECT_ID_HEX_PATTERN = /^[a-f\d]{24}$/i;

/**
 * Converts a Better Auth user identifier from a verified JWT into the ObjectId
 * stored in Better Auth's `user._id` field. Returns null for invalid values so
 * callers fail closed instead of querying the collection with an untrusted
 * string.
 */
export function toBetterAuthUserObjectId(value: unknown): ObjectId | null {
  return typeof value === 'string' && OBJECT_ID_HEX_PATTERN.test(value)
    ? new ObjectId(value)
    : null;
}

/** Parses a canonical ObjectId route parameter, rejecting malformed values. */
export function parseObjectId(value: string, label: string): ObjectId {
  if (!OBJECT_ID_HEX_PATTERN.test(value)) {
    throw new AppError(`Invalid ${label} ID.`, 400, true, 'INVALID_OBJECT_ID');
  }

  return new ObjectId(value);
}
