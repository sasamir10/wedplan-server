import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId, type Db } from 'mongodb';
import {
  blockUser,
  getAdminUserDetails,
  listAdminUsers,
  parseListFilters,
  unblockUser,
} from '../src/services/admin-users.service.js';
import { AppError } from '../src/utils/app-error.js';

type MemoryDocument = Record<string, unknown> & { _id: string | ObjectId };

const adminObjectId = new ObjectId();
const ADMIN_ID = adminObjectId.toHexString();
const customerOneObjectId = new ObjectId();
const CUSTOMER_ONE_ID = customerOneObjectId.toHexString();
const vendorOneObjectId = new ObjectId();
const VENDOR_ONE_ID = vendorOneObjectId.toHexString();

function matches(document: MemoryDocument, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') {
      const conditions = value as Record<string, unknown>[];
      return conditions.some((condition) => matches(document, condition));
    }
    const actual = document[key];
    if (actual instanceof ObjectId && value instanceof ObjectId) {
      return actual.equals(value);
    }
    if (value !== null && typeof value === 'object' && '$regex' in value) {
      const regexValue = value as { $regex: string; $options?: string };
      return (
        typeof actual === 'string' &&
        new RegExp(regexValue.$regex, regexValue.$options ?? '').test(actual)
      );
    }
    return actual === value;
  });
}

function createMemoryDatabase(overrides: { users: MemoryDocument[] }) {
  const users = [...overrides.users];

  const database = {
    collection(name: string) {
      if (name === 'user') {
        return {
          findOne: async (
            filter: Record<string, unknown>,
            options?: { projection?: Record<string, unknown> },
          ) => {
            const user = users.find((entry) => matches(entry, filter));

            if (!user) return null;

            if (!options?.projection) return user;

            const projected: Record<string, unknown> = {};
            for (const [key, include] of Object.entries(options.projection)) {
              if (include === 1) {
                projected[key] = user[key];
              }
            }
            return projected;
          },
          findOneAndUpdate: async (
            filter: Record<string, unknown>,
            update: { $set: Record<string, unknown> },
            options?: { returnDocument?: string; projection?: Record<string, unknown> },
          ) => {
            const userIndex = users.findIndex((entry) => matches(entry, filter));
            if (userIndex === -1) return null;

            const user = { ...users[userIndex] };
            for (const [key, value] of Object.entries(update.$set)) {
              user[key] = value;
            }
            users[userIndex] = user;

            if (options?.returnDocument === 'after' && options?.projection) {
              const projected: Record<string, unknown> = {};
              for (const [key, include] of Object.entries(options.projection)) {
                if (include === 1) {
                  projected[key] = user[key];
                }
              }
              return projected;
            }

            return user;
          },
          countDocuments: async (filter: Record<string, unknown>) =>
            users.filter((user) => matches(user, filter)).length,
          find: (filter: Record<string, unknown>) => {
            let result = users.filter((user) => matches(user, filter));
            let sortField = 'createdAt';
            let sortOrder = -1;
            let skipCount = 0;
            let limitCount = 0;
            const chain: Record<string, unknown> = {
              sort: (spec: Record<string, unknown>) => {
                const [field, order] = Object.entries(spec)[0];
                sortField = field as string;
                sortOrder = Number(order) === -1 ? -1 : 1;
                return chain;
              },
              skip: (n: number) => {
                skipCount = Number(n);
                return chain;
              },
              limit: (n: number) => {
                limitCount = Number(n);
                return chain;
              },
              toArray: async () => {
                result.sort((a, b) => {
                  const aVal = a[sortField] as unknown as string | number | Date | undefined;
                  const bVal = b[sortField] as unknown as string | number | Date | undefined;
                  const aStr = String(aVal ?? '');
                  const bStr = String(bVal ?? '');
                  if (aStr < bStr) return sortOrder;
                  if (aStr > bStr) return -sortOrder;
                  return 0;
                });
                return result.slice(skipCount, skipCount + limitCount);
              },
            };
            return chain;
          },
        };
      }

      throw new Error(`Unexpected collection: ${name}`);
    },
  };

  return database as unknown as Db;
}

function userRecord(
  idHex: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    _id: new ObjectId(idHex),
    name: 'Test User',
    email: 'user@example.com',
    role: 'customer',
    isBlocked: false,
    businessName: null,
    subscriptionPlan: 'free',
    createdAt: new Date(),
    ...overrides,
  };
}

test('listAdminUsers returns all users with safe fields', async () => {
  const database = createMemoryDatabase({
    users: [
      userRecord(ADMIN_ID, { role: 'admin', name: 'Admin User' }),
      userRecord(CUSTOMER_ONE_ID, { role: 'customer', name: 'Customer One' }),
      userRecord(VENDOR_ONE_ID, { role: 'vendor', name: 'Vendor One' }),
    ],
  });

  const result = await listAdminUsers(database, {
    page: 1,
    limit: 20,
  });

  assert.equal(result.users.length, 3);
  assert.equal(result.pagination.total, 3);
  assert.equal(result.pagination.page, 1);
  assert.equal(result.pagination.limit, 20);
  assert.equal(result.pagination.totalPages, 1);

  // Verify no sensitive fields are exposed
  for (const user of result.users) {
    const userKeys = user as unknown as Record<string, unknown>;
    assert.equal(userKeys.password, undefined);
    assert.equal(userKeys.subscriptionExpiresAt, undefined);
    assert.equal(userKeys.signupRole, undefined);
    assert.equal(typeof user.id, 'string');
    assert.equal(typeof user.email, 'string');
    assert.equal(typeof user.role, 'string');
    assert.equal(typeof user.isBlocked, 'boolean');
  }
});

test('listAdminUsers search matches name case-insensitively', async () => {
  const database = createMemoryDatabase({
    users: [
      userRecord(ADMIN_ID, { role: 'admin', name: 'Admin User' }),
      userRecord(CUSTOMER_ONE_ID, { role: 'customer', name: 'Customer One' }),
      userRecord(VENDOR_ONE_ID, { role: 'vendor', name: 'Vendor One' }),
    ],
  });

  const result = await listAdminUsers(database, {
    search: 'customer',
    page: 1,
    limit: 20,
  });

  assert.equal(result.users.length, 1);
  assert.equal(result.users[0].name, 'Customer One');
});

test('listAdminUsers search matches email case-insensitively', async () => {
  const database = createMemoryDatabase({
    users: [
      userRecord(ADMIN_ID, { role: 'admin', email: 'ADMIN@EXAMPLE.COM' }),
      userRecord(CUSTOMER_ONE_ID, { role: 'customer', email: 'customer@example.com' }),
    ],
  });

  const result = await listAdminUsers(database, {
    search: 'ADMIN@EXAMPLE.COM',
    page: 1,
    limit: 20,
  });

  assert.equal(result.users.length, 1);
  assert.equal(result.users[0].email, 'ADMIN@EXAMPLE.COM');
});

test('listAdminUsers search escapes regex metacharacters', async () => {
  const database = createMemoryDatabase({
    users: [
      userRecord(CUSTOMER_ONE_ID, { role: 'customer', name: 'Price $100' }),
    ],
  });

  const result = await listAdminUsers(database, {
    search: '$100',
    page: 1,
    limit: 20,
  });

  assert.equal(result.users.length, 1);
  assert.equal(result.users[0].name, 'Price $100');
});

test('listAdminUsers filters by role', async () => {
  const database = createMemoryDatabase({
    users: [
      userRecord(ADMIN_ID, { role: 'admin' }),
      userRecord(CUSTOMER_ONE_ID, { role: 'customer' }),
      userRecord(VENDOR_ONE_ID, { role: 'vendor' }),
      userRecord(new ObjectId().toHexString(), { role: 'vendor' }),
    ],
  });

  const result = await listAdminUsers(database, {
    role: 'vendor',
    page: 1,
    limit: 20,
  });

  assert.equal(result.users.length, 2);
  assert.ok(result.users.every((user) => user.role === 'vendor'));
});

test('listAdminUsers pagination is accurate', async () => {
  const database = createMemoryDatabase({
    users: [
      userRecord(ADMIN_ID, { role: 'admin' }),
      userRecord(CUSTOMER_ONE_ID, { role: 'customer' }),
      userRecord(VENDOR_ONE_ID, { role: 'vendor' }),
      userRecord(new ObjectId().toHexString(), { role: 'customer' }),
      userRecord(new ObjectId().toHexString(), { role: 'vendor' }),
    ],
  });

  const page1 = await listAdminUsers(database, { page: 1, limit: 2 });
  assert.equal(page1.users.length, 2);
  assert.equal(page1.pagination.total, 5);
  assert.equal(page1.pagination.totalPages, 3);

  const page2 = await listAdminUsers(database, { page: 2, limit: 2 });
  assert.equal(page2.users.length, 2);
  assert.equal(page2.pagination.page, 2);
});

test('listAdminUsers invalid page and limit are constrained', async () => {
  const result = parseListFilters({ page: '0', limit: '9999' });
  assert.equal(result.page, 1);
  assert.equal(result.limit, 100);
});

test('getAdminUserDetails returns safe user details', async () => {
  const database = createMemoryDatabase({
    users: [
      userRecord(CUSTOMER_ONE_ID, { name: 'Customer One', email: 'customer@example.com' }),
    ],
  });

  const user = await getAdminUserDetails(database, CUSTOMER_ONE_ID);

  assert.equal(user.id, CUSTOMER_ONE_ID);
  assert.equal(user.name, 'Customer One');
  assert.equal(user.email, 'customer@example.com');
  assert.equal(user.role, 'customer');
  assert.equal(user.isBlocked, false);
});

test('getAdminUserDetails rejects invalid user ID', async () => {
  const database = createMemoryDatabase({ users: [] });

  await assert.rejects(
    () => getAdminUserDetails(database, 'not-a-valid-object-id'),
    { statusCode: 400, code: 'INVALID_OBJECT_ID' },
  );
});

test('getAdminUserDetails returns 404 for missing user', async () => {
  const database = createMemoryDatabase({ users: [] });

  await assert.rejects(
    () => getAdminUserDetails(database, CUSTOMER_ONE_ID),
    { statusCode: 404, code: 'USER_NOT_FOUND' },
  );
});

test('blockUser blocks a customer', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(CUSTOMER_ONE_ID, { isBlocked: false })],
  });

  const result = await blockUser(database, ADMIN_ID, CUSTOMER_ONE_ID);

  assert.equal(result.isBlocked, true);
  assert.equal(result.id, CUSTOMER_ONE_ID);
});

test('blockUser blocks a vendor', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(VENDOR_ONE_ID, { role: 'vendor', isBlocked: false })],
  });

  const result = await blockUser(database, ADMIN_ID, VENDOR_ONE_ID);

  assert.equal(result.isBlocked, true);
  assert.equal(result.role, 'vendor');
});

test('blockUser does not modify role or subscription', async () => {
  const database = createMemoryDatabase({
    users: [
      userRecord(VENDOR_ONE_ID, {
        role: 'vendor',
        subscriptionPlan: 'premium',
        isBlocked: false,
      }),
    ],
  });

  await blockUser(database, ADMIN_ID, VENDOR_ONE_ID);

  const user = await getAdminUserDetails(database, VENDOR_ONE_ID);
  assert.equal(user.role, 'vendor');
  assert.equal(user.subscriptionPlan, 'premium');
  assert.equal(user.isBlocked, true);
});

test('blockUser prevents admin from blocking themselves', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(ADMIN_ID, { role: 'admin' })],
  });

  await assert.rejects(
    () => blockUser(database, ADMIN_ID, ADMIN_ID),
    { statusCode: 400, code: 'CANNOT_BLOCK_SELF' },
  );
});

test('blockUser rejects already-blocked user', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(CUSTOMER_ONE_ID, { isBlocked: true })],
  });

  await assert.rejects(
    () => blockUser(database, ADMIN_ID, CUSTOMER_ONE_ID),
    { statusCode: 409, code: 'ALREADY_BLOCKED' },
  );
});

test('blockUser rejects invalid target ID', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(ADMIN_ID, { role: 'admin' })],
  });

  await assert.rejects(
    () => blockUser(database, ADMIN_ID, 'not-a-valid-object-id'),
    { statusCode: 400, code: 'INVALID_OBJECT_ID' },
  );
});

test('blockUser rejects nonexistent target user', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(ADMIN_ID, { role: 'admin' })],
  });

  await assert.rejects(
    () => blockUser(database, ADMIN_ID, new ObjectId().toHexString()),
    { statusCode: 404, code: 'USER_NOT_FOUND' },
  );
});

test('unblockUser unblocks a blocked user', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(CUSTOMER_ONE_ID, { isBlocked: true })],
  });

  const result = await unblockUser(database, CUSTOMER_ONE_ID);

  assert.equal(result.isBlocked, false);
  assert.equal(result.id, CUSTOMER_ONE_ID);
});

test('unblockUser rejects already-unblocked user', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(CUSTOMER_ONE_ID, { isBlocked: false })],
  });

  await assert.rejects(
    () => unblockUser(database, CUSTOMER_ONE_ID),
    { statusCode: 409, code: 'NOT_BLOCKED' },
  );
});

test('unblockUser rejects invalid target ID', async () => {
  const database = createMemoryDatabase({ users: [] });

  await assert.rejects(
    () => unblockUser(database, 'not-a-valid-object-id'),
    { statusCode: 400, code: 'INVALID_OBJECT_ID' },
  );
});

test('unblockUser rejects nonexistent target user', async () => {
  const database = createMemoryDatabase({ users: [] });

  await assert.rejects(
    () => unblockUser(database, new ObjectId().toHexString()),
    { statusCode: 404, code: 'USER_NOT_FOUND' },
  );
});
