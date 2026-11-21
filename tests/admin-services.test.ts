import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId, type Db } from 'mongodb';
import {
  adminServiceQuerySchema,
  adminServiceStatusSchema,
  emptyAdminServiceBodySchema,
} from '../src/models/admin-service.js';
import type { ServiceDocument } from '../src/services/service.service.js';
import {
  approvePendingService,
  deleteAdminService,
  listAdminServices,
  rejectPendingService,
  updateAdminServiceStatus,
} from '../src/services/admin-service.service.js';
import { AppError } from '../src/utils/app-error.js';

type MemoryRecord = Record<string, unknown> & { _id: string | ObjectId };

function matches(record: MemoryRecord, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = record[key];
    if (expected instanceof ObjectId) {
      return actual instanceof ObjectId && actual.equals(expected);
    }
    if (typeof expected === 'object' && expected !== null) {
      const operators = expected as Record<string, unknown>;
      if ('$in' in operators) {
        return Array.isArray(operators.$in) && operators.$in.includes(actual);
      }
      if ('$ne' in operators) return actual !== operators.$ne;
      if ('$regex' in operators) {
        return (
          typeof actual === 'string' &&
          new RegExp(String(operators.$regex), String(operators.$options ?? '')).test(actual)
        );
      }
    }
    return actual === expected;
  });
}

function createService(
  vendorId: string,
  serviceName: string,
  overrides: Partial<ServiceDocument> = {},
): ServiceDocument {
  const now = new Date('2026-11-21T00:00:00.000Z');
  return {
    _id: new ObjectId(),
    vendorId,
    serviceName,
    category: 'Photography & Videography',
    description: 'Wedding coverage with edited photos delivered in a gallery.',
    price: 1200,
    location: 'Dhaka',
    images: ['https://images.example.com/wedding.jpg'],
    status: 'Pending',
    availability: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createDatabase(initial: ServiceDocument[] = []) {
  const services = [...initial] as MemoryRecord[];
  const users: MemoryRecord[] = [
    { _id: 'vendor-1', name: 'Ayesha Rahman', businessName: 'Ayesha Photography', email: 'private@example.com' },
    { _id: 'vendor-2', name: 'Nabil Hasan', businessName: 'Nabil Films', email: 'private2@example.com' },
  ];

  const database = {
    collection(name: string) {
      if (name === 'user') {
        return {
          find: (filter: Record<string, unknown>) => {
            let records = users.filter((user) => matches(user, filter));
            return {
              project: () => ({ toArray: async () => records }),
              toArray: async () => records,
            };
          },
          findOne: async (filter: Record<string, unknown>) =>
            users.find((user) => matches(user, filter)) ?? null,
        };
      }
      if (name !== 'services') throw new Error('Unexpected collection.');

      return {
        find: (filter: Record<string, unknown>) => {
          let records = services.filter((service) => matches(service, filter));
          return {
            sort: () => ({
              skip: (amount: number) => ({
                limit: (limit: number) => ({
                  toArray: async () => records.slice(amount, amount + limit),
                }),
              }),
            }),
            toArray: async () => records,
          };
        },
        countDocuments: async (filter: Record<string, unknown>) =>
          services.filter((service) => matches(service, filter)).length,
        findOne: async (filter: Record<string, unknown>) =>
          services.find((service) => matches(service, filter)) ?? null,
        findOneAndUpdate: async (
          filter: Record<string, unknown>,
          update: { $set: Record<string, unknown> },
        ) => {
          const service = services.find((entry) => matches(entry, filter));
          if (!service) return null;
          Object.assign(service, update.$set);
          return service;
        },
        deleteOne: async (filter: Record<string, unknown>) => {
          const index = services.findIndex((service) => matches(service, filter));
          if (index < 0) return { deletedCount: 0 };
          services.splice(index, 1);
          return { deletedCount: 1 };
        },
      };
    },
  };

  return { database: database as unknown as Db, services };
}

test('admin service query validates filters and applies safe pagination defaults', () => {
  const parsed = adminServiceQuerySchema.parse({
    search: '  Photo.  ',
    status: 'Pending',
    category: 'Photography & Videography',
    availability: 'false',
    limit: '5',
  });
  assert.equal(parsed.search, 'Photo.');
  assert.equal(parsed.status, 'Pending');
  assert.equal(parsed.availability, false);
  assert.equal(parsed.page, 1);
  assert.equal(parsed.limit, 5);

  assert.equal(adminServiceQuerySchema.safeParse({ availability: 'sometimes' }).success, false);
  assert.equal(adminServiceQuerySchema.safeParse({ status: 'Published' }).success, false);
  assert.equal(adminServiceQuerySchema.safeParse({ limit: '1000' }).success, false);
  assert.equal(adminServiceQuerySchema.safeParse({ role: 'admin' }).success, false);
  assert.equal(emptyAdminServiceBodySchema.safeParse({}).success, true);
  assert.equal(
    emptyAdminServiceBodySchema.safeParse({ vendorId: 'client-choice' }).success,
    false,
  );
});

test('admin listing spans vendors, filters services, paginates, and returns limited vendor fields', async () => {
  const first = createService('vendor-1', 'Ayesha Photo. Studio');
  const second = createService('vendor-2', 'Nabil Wedding Films', {
    status: 'Approved',
    availability: false,
    category: 'Wedding Fashion',
  });
  const third = createService('vendor-2', 'Nabil Photo Booth');
  const { database } = createDatabase([first, second, third]);

  const all = await listAdminServices(database, adminServiceQuerySchema.parse({ page: '1', limit: '2' }));
  assert.equal(all.pagination.total, 3);
  assert.equal(all.pagination.totalPages, 2);
  assert.equal(all.services.length, 2);
  assert.equal(all.services[0]?.vendor?.businessName, 'Ayesha Photography');
  assert.equal('email' in (all.services[0]?.vendor ?? {}), false);

  const filtered = await listAdminServices(
    database,
    adminServiceQuerySchema.parse({
      search: 'PHOTO',
      status: 'Pending',
      availability: 'true',
    }),
  );
  assert.deepEqual(filtered.services.map((service) => service.serviceName), [
    'Ayesha Photo. Studio',
    'Nabil Photo Booth',
  ]);
  assert.equal(filtered.pagination.total, 2);

  const literalPunctuation = await listAdminServices(
    database,
    adminServiceQuerySchema.parse({ search: 'photo.' }),
  );
  assert.deepEqual(
    literalPunctuation.services.map((service) => service.serviceName),
    ['Ayesha Photo. Studio'],
  );

  const categoryFiltered = await listAdminServices(
    database,
    adminServiceQuerySchema.parse({
      category: 'Wedding Fashion',
      status: 'Approved',
      availability: 'false',
    }),
  );
  assert.deepEqual(
    categoryFiltered.services.map((service) => service.serviceName),
    ['Nabil Wedding Films'],
  );
});

test('approves pending service atomically without changing ownership or availability', async () => {
  const pending = createService('vendor-1', 'Ayesha Photo Studio', { availability: false });
  const { database } = createDatabase([pending]);
  const updated = await approvePendingService(database, pending._id.toHexString());

  assert.equal(updated.status, 'Approved');
  assert.equal(updated.vendorId, 'vendor-1');
  assert.equal(updated.availability, false);
  assert.ok(updated.updatedAt.getTime() >= pending.createdAt.getTime());
});

test('rejects pending service and prevents repeated review transitions', async () => {
  const pending = createService('vendor-1', 'Ayesha Photo Studio');
  const { database } = createDatabase([pending]);
  const rejected = await rejectPendingService(database, pending._id.toHexString());
  assert.equal(rejected.status, 'Rejected');

  await assert.rejects(
    () => approvePendingService(database, pending._id.toHexString()),
    { statusCode: 409 },
  );
});

test('admin status changes allow supported transitions and preserve availability and ownership', async () => {
  const approved = createService('vendor-2', 'Nabil Wedding Films', {
    status: 'Approved',
    availability: false,
  });
  const { database } = createDatabase([approved]);
  const updated = await updateAdminServiceStatus(
    database,
    approved._id.toHexString(),
    'Rejected',
  );

  assert.equal(updated.status, 'Rejected');
  assert.equal(updated.vendorId, 'vendor-2');
  assert.equal(updated.availability, false);
  assert.equal(adminServiceStatusSchema.safeParse({ status: 'Removed' }).success, false);
  assert.equal(
    adminServiceStatusSchema.safeParse({ status: 'Rejected', availability: true }).success,
    false,
  );

  await assert.rejects(
    () => updateAdminServiceStatus(database, approved._id.toHexString(), 'Rejected'),
    { statusCode: 409 },
  );
});

test('rejects invalid and missing service IDs without querying arbitrary IDs', async () => {
  const { database } = createDatabase();
  await assert.rejects(() => approvePendingService(database, 'not-an-object-id'), {
    statusCode: 400,
  });
  await assert.rejects(() => deleteAdminService(database, new ObjectId().toHexString()), {
    statusCode: 404,
  });
});

test('admin can delete an existing service and missing service returns 404', async () => {
  const service = createService('vendor-1', 'Ayesha Photo Studio');
  const { database, services } = createDatabase([service]);

  await deleteAdminService(database, service._id.toHexString());
  assert.equal(services.length, 0);
  await assert.rejects(() => deleteAdminService(database, service._id.toHexString()), {
    statusCode: 404,
  });
});

test('admin status operation failures are safe application errors', async () => {
  const { database } = createDatabase();
  await assert.rejects(
    () => updateAdminServiceStatus(database, 'bad-id', 'Approved'),
    (error: unknown) =>
      error instanceof AppError && error.statusCode === 400 && error.message === 'Invalid service ID.',
  );
});
