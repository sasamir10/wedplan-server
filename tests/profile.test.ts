import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId, type Db } from 'mongodb';
import { getProfile, updateProfile } from '../src/services/profile.service.js';
import { AppError } from '../src/utils/app-error.js';

type MemoryDocument = Record<string, unknown> & { _id: string | ObjectId };

const userOneObjectId = new ObjectId();
const USER_ONE_ID = userOneObjectId.toHexString();
const USER_TWO_ID = new ObjectId().toHexString();

function matches(document: MemoryDocument, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => {
    const actual = document[key];
    if (actual instanceof ObjectId && value instanceof ObjectId) {
      return actual.equals(value);
    }
    return actual === value;
  });
}

function createMemoryDatabase(overrides: {
  users: MemoryDocument[];
}) {
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
              if (include === 1 && key !== '_id') {
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
                if (include === 1 && key !== '_id') {
                  projected[key] = user[key];
                }
              }
              return projected;
            }

            return user;
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
    image: null,
    role: 'customer',
    isBlocked: false,
    businessName: null,
    subscriptionPlan: 'free',
    subscriptionExpiresAt: null,
    signupRole: 'customer',
    signupBusinessName: null,
    emailVerified: true,
    password: 'hashed-password',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

test('getProfile returns safe profile information', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(USER_ONE_ID)],
  });

  const profile = await getProfile(database, USER_ONE_ID);

  assert.equal(profile.id, USER_ONE_ID);
  assert.equal(profile.name, 'Test User');
  assert.equal(profile.email, 'user@example.com');
  assert.equal(profile.image, null);
  assert.equal(profile.role, 'customer');
  assert.equal(profile.businessName, null);
  assert.equal(profile.subscriptionPlan, 'free');
});

test('getProfile does not return password or sensitive fields', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(USER_ONE_ID, { password: 'secret-hash' })],
  });

  const profile = await getProfile(database, USER_ONE_ID);

  const profileKeys = profile as unknown as Record<string, unknown>;
  assert.equal(profileKeys.password, undefined);
  assert.equal(profileKeys.isBlocked, undefined);
  assert.equal(profileKeys.subscriptionExpiresAt, undefined);
  assert.equal(profileKeys.signupRole, undefined);
});

test('getProfile throws when userId is not a valid ObjectId hex', async () => {
  const database = createMemoryDatabase({ users: [] });

  await assert.rejects(
    () => getProfile(database, 'not-a-valid-object-id'),
    { statusCode: 403, code: 'USER_NOT_FOUND' },
  );
});

test('getProfile throws when user record not found', async () => {
  const database = createMemoryDatabase({ users: [] });

  await assert.rejects(
    () => getProfile(database, USER_ONE_ID),
    { statusCode: 403, code: 'USER_NOT_FOUND' },
  );
});

test('updateProfile updates the user name', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(USER_ONE_ID, { name: 'Old Name' })],
  });

  const profile = await updateProfile(database, USER_ONE_ID, { name: 'New Name' });

  assert.equal(profile.name, 'New Name');
  assert.equal(profile.email, 'user@example.com');
});

test('updateProfile updates the user image', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(USER_ONE_ID, { image: null })],
  });

  const profile = await updateProfile(database, USER_ONE_ID, {
    image: 'https://i.ibb.co/abc123/profile.jpg',
  });

  assert.equal(profile.image, 'https://i.ibb.co/abc123/profile.jpg');
});

test('updateProfile updates both name and image', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(USER_ONE_ID)],
  });

  const profile = await updateProfile(database, USER_ONE_ID, {
    name: 'Updated Name',
    image: 'https://i.ibb.co/def456/profile.jpg',
  });

  assert.equal(profile.name, 'Updated Name');
  assert.equal(profile.image, 'https://i.ibb.co/def456/profile.jpg');
});

test('updateProfile scopes updates to the authenticated user only', async () => {
  const database = createMemoryDatabase({
    users: [
      userRecord(USER_ONE_ID, { name: 'User One' }),
      userRecord(USER_TWO_ID, { name: 'User Two' }),
    ],
  });

  const profile = await updateProfile(database, USER_ONE_ID, {
    name: 'Updated User One',
  });

  assert.equal(profile.name, 'Updated User One');
  assert.equal(profile.id, USER_ONE_ID);
});

test('updateProfile rejects attempts to modify role', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(USER_ONE_ID, { role: 'customer' })],
  });

  await assert.rejects(
    () => updateProfile(database, USER_ONE_ID, { role: 'admin' as any }),
    { statusCode: 400 },
  );
});

test('updateProfile rejects attempts to modify subscriptionPlan', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(USER_ONE_ID, { subscriptionPlan: 'free' })],
  });

  await assert.rejects(
    () => updateProfile(database, USER_ONE_ID, { subscriptionPlan: 'premium' as any }),
    { statusCode: 400 },
  );
});

test('updateProfile rejects attempts to modify isBlocked', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(USER_ONE_ID, { isBlocked: false })],
  });

  await assert.rejects(
    () => updateProfile(database, USER_ONE_ID, { isBlocked: true as any }),
    { statusCode: 400 },
  );
});

test('updateProfile rejects invalid name (empty)', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(USER_ONE_ID)],
  });

  await assert.rejects(
    () => updateProfile(database, USER_ONE_ID, { name: '' }),
    { statusCode: 400 },
  );
});

test('updateProfile rejects invalid image URL', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(USER_ONE_ID)],
  });

  await assert.rejects(
    () => updateProfile(database, USER_ONE_ID, { image: 'not-a-url' }),
    { statusCode: 400 },
  );
});

test('updateProfile rejects non-i.ibb.co image URLs', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(USER_ONE_ID)],
  });

  await assert.rejects(
    () => updateProfile(database, USER_ONE_ID, { image: 'https://example.com/photo.jpg' }),
    { statusCode: 400 },
  );
});

test('updateProfile rejects no fields to update', async () => {
  const database = createMemoryDatabase({
    users: [userRecord(USER_ONE_ID)],
  });

  await assert.rejects(
    () => updateProfile(database, USER_ONE_ID, {}),
    { statusCode: 400 },
  );
});

test('updateProfile throws when user record not found', async () => {
  const database = createMemoryDatabase({ users: [] });

  await assert.rejects(
    () => updateProfile(database, USER_ONE_ID, { name: 'New Name' }),
    { statusCode: 403, code: 'USER_NOT_FOUND' },
  );
});

test('updateProfile throws when userId is not a valid ObjectId hex', async () => {
  const database = createMemoryDatabase({ users: [userRecord(USER_ONE_ID)] });

  await assert.rejects(
    () => updateProfile(database, 'not-a-valid-object-id', { name: 'New Name' }),
    { statusCode: 403, code: 'USER_NOT_FOUND' },
  );
});
