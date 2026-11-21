import {
  type Collection,
  type Db,
  type Filter,
  type ObjectId,
  type WithId,
} from 'mongodb';
import { AppError } from '../utils/app-error.js';
import { parseObjectId, toBetterAuthUserObjectId } from '../utils/object-id.js';

const VALID_ROLES = ['admin', 'customer', 'vendor'] as const;

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

interface SafeUser {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  role: string;
  isBlocked: boolean;
  businessName: string | null;
  subscriptionPlan: string;
  createdAt: Date;
}

interface UserListFilters {
  search?: string;
  role?: string;
  page: number;
  limit: number;
}

interface UserListResult {
  users: SafeUser[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

interface BlockTarget {
  id: string;
  name: string | null;
  email: string;
  role: string;
  isBlocked: boolean;
}

function usersCollection(database: Db): Collection {
  return database.collection('user');
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isValidRole(value: unknown): value is 'admin' | 'customer' | 'vendor' {
  return VALID_ROLES.includes(value as typeof VALID_ROLES[number]);
}

function toSafeUser(user: WithId<Record<string, unknown>>): SafeUser {
  return {
    id: user._id.toHexString(),
    name: typeof user.name === 'string' ? user.name : null,
    email: typeof user.email === 'string' ? user.email : '',
    image: typeof user.image === 'string' ? user.image : null,
    role: typeof user.role === 'string' ? user.role : 'customer',
    isBlocked: user.isBlocked === true,
    businessName:
      typeof user.businessName === 'string' ? user.businessName : null,
    subscriptionPlan:
      typeof user.subscriptionPlan === 'string'
        ? user.subscriptionPlan
        : 'free',
    createdAt:
      user.createdAt instanceof Date ? user.createdAt : new Date(),
  };
}

function buildUserFilter(filters: {
  search?: string;
  role?: string;
}): Filter<Record<string, unknown>> {
  const filter: Filter<Record<string, unknown>> = {};

  if (filters.search) {
    const escaped = escapeRegularExpression(filters.search.trim());
    filter.$or = [
      { name: { $regex: escaped, $options: 'i' } },
      { email: { $regex: escaped, $options: 'i' } },
    ];
  }

  if (filters.role && isValidRole(filters.role)) {
    filter.role = filters.role;
  }

  return filter;
}

export async function listAdminUsers(
  database: Db,
  filters: UserListFilters,
): Promise<UserListResult> {
  const queryFilter = buildUserFilter(filters);

  const usersCollectionInstance = usersCollection(database);

  const [total, users] = await Promise.all([
    usersCollectionInstance.countDocuments(queryFilter),
    usersCollectionInstance
      .find(queryFilter)
      .sort({ createdAt: -1 })
      .skip((filters.page - 1) * filters.limit)
      .limit(filters.limit)
      .toArray(),
  ]);

  return {
    users: users.map(toSafeUser),
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      totalPages: Math.ceil(total / filters.limit),
    },
  };
}

export async function getAdminUserDetails(
  database: Db,
  userId: string,
): Promise<SafeUser> {
  const userObjectId = toBetterAuthUserObjectId(userId);

  if (!userObjectId) {
    throw new AppError('Invalid user ID.', 400, true, 'INVALID_OBJECT_ID');
  }

  const user = await usersCollection(database).findOne(
    { _id: userObjectId },
    {
      projection: {
        name: 1,
        email: 1,
        image: 1,
        role: 1,
        isBlocked: 1,
        businessName: 1,
        subscriptionPlan: 1,
        createdAt: 1,
        _id: 1,
      },
    },
  );

  if (!user) {
    throw new AppError('User not found.', 404, true, 'USER_NOT_FOUND');
  }

  return toSafeUser(user);
}

async function findUserById(
  database: Db,
  userId: string,
): Promise<BlockTarget | null> {
  const userObjectId = toBetterAuthUserObjectId(userId);

  if (!userObjectId) return null;

  const user = await usersCollection(database).findOne(
    { _id: userObjectId },
    {
      projection: {
        name: 1,
        email: 1,
        role: 1,
        isBlocked: 1,
        _id: 1,
      },
    },
  );

  if (!user) return null;

  return {
    id: user._id.toHexString(),
    name: typeof user.name === 'string' ? user.name : null,
    email: typeof user.email === 'string' ? user.email : '',
    role: typeof user.role === 'string' ? user.role : 'customer',
    isBlocked: user.isBlocked === true,
  };
}

export async function blockUser(
  database: Db,
  actorId: string,
  targetUserId: string,
): Promise<BlockTarget> {
  if (actorId === targetUserId) {
    throw new AppError(
      'You cannot block your own account.',
      400,
      true,
      'CANNOT_BLOCK_SELF',
    );
  }

  const targetUserObjectId = toBetterAuthUserObjectId(targetUserId);
  if (!targetUserObjectId) {
    throw new AppError('Invalid user ID.', 400, true, 'INVALID_OBJECT_ID');
  }

  const target = await findUserById(database, targetUserId);

  if (!target) {
    throw new AppError('User not found.', 404, true, 'USER_NOT_FOUND');
  }

  if (target.isBlocked) {
    throw new AppError(
      'User is already blocked.',
      409,
      true,
      'ALREADY_BLOCKED',
    );
  }

  const result = await usersCollection(database).findOneAndUpdate(
    { _id: targetUserObjectId },
    { $set: { isBlocked: true } },
    { returnDocument: 'after' },
  );

  if (!result) {
    throw new AppError('User not found.', 404, true, 'USER_NOT_FOUND');
  }

  return {
    id: target.id,
    name: target.name,
    email: target.email,
    role: target.role,
    isBlocked: true,
  };
}

export async function unblockUser(
  database: Db,
  targetUserId: string,
): Promise<BlockTarget> {
  const targetUserObjectId = toBetterAuthUserObjectId(targetUserId);
  if (!targetUserObjectId) {
    throw new AppError('Invalid user ID.', 400, true, 'INVALID_OBJECT_ID');
  }

  const target = await findUserById(database, targetUserId);

  if (!target) {
    throw new AppError('User not found.', 404, true, 'USER_NOT_FOUND');
  }

  if (!target.isBlocked) {
    throw new AppError(
      'User is not blocked.',
      409,
      true,
      'NOT_BLOCKED',
    );
  }

  const userObjectId = toBetterAuthUserObjectId(targetUserId);
  if (!userObjectId) {
    throw new AppError('Invalid user ID.', 400, true, 'INVALID_OBJECT_ID');
  }

  const result = await usersCollection(database).findOneAndUpdate(
    { _id: targetUserObjectId },
    { $set: { isBlocked: false } },
    { returnDocument: 'after' },
  );

  if (!result) {
    throw new AppError('User not found.', 404, true, 'USER_NOT_FOUND');
  }

  return {
    id: target.id,
    name: target.name,
    email: target.email,
    role: target.role,
    isBlocked: false,
  };
}

export function parseListFilters(query: unknown): UserListFilters {
  const search =
    typeof query === 'object' && query !== null && 'search' in query
      ? String((query as Record<string, unknown>).search ?? '')
      : '';
  const role =
    typeof query === 'object' && query !== null && 'role' in query
      ? String((query as Record<string, unknown>).role ?? '')
      : '';
  const pageRaw =
    typeof query === 'object' && query !== null && 'page' in query
      ? String((query as Record<string, unknown>).page ?? '1')
      : '1';
  const limitRaw =
    typeof query === 'object' && query !== null && 'limit' in query
      ? String((query as Record<string, unknown>).limit ?? String(DEFAULT_PAGE_SIZE))
      : String(DEFAULT_PAGE_SIZE);

  const page = Math.max(1, Number.parseInt(pageRaw, 10) || 1);
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(limitRaw, 10) || DEFAULT_PAGE_SIZE),
  );

  return {
    search: search.length > 0 ? search : undefined,
    role: role.length > 0 ? role : undefined,
    page,
    limit,
  };
}
