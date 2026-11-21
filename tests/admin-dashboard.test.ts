import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId, type Db } from 'mongodb';
import { getAdminStats } from '../src/services/admin-dashboard.service.js';
import { AppError } from '../src/utils/app-error.js';

type MemoryDocument = Record<string, unknown> & { _id: string | ObjectId };

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
  services: MemoryDocument[];
  transactions: MemoryDocument[];
}) {
  const users = [...overrides.users];
  const services = [...overrides.services];
  const transactions = [...overrides.transactions];

  const database = {
    collection(name: string) {
      if (name === 'user') {
        return {
          countDocuments: async (filter?: Record<string, unknown>) => {
            if (!filter) return users.length;
            return users.filter((user) => matches(user, filter)).length;
          },
        };
      }

      if (name === 'services') {
        return {
          countDocuments: async (filter?: Record<string, unknown>) => {
            if (!filter) return services.length;
            return services.filter((service) => matches(service, filter)).length;
          },
        };
      }

      if (name === 'transactions') {
        return {
          countDocuments: async () => transactions.length,
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
    ...overrides,
  };
}

function serviceRecord(overrides: Record<string, unknown> = {}) {
  return {
    _id: new ObjectId(),
    vendorId: new ObjectId().toHexString(),
    serviceName: 'Wedding Photography',
    category: 'Photography & Videography',
    description: 'Professional wedding photography',
    price: 12000,
    location: 'Dhaka',
    images: ['https://example.com/photo.jpg'],
    status: 'Pending',
    availability: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function transactionRecord(overrides: Record<string, unknown> = {}) {
  return {
    _id: new ObjectId(),
    customerId: new ObjectId().toHexString(),
    vendorId: new ObjectId().toHexString(),
    serviceId: new ObjectId().toHexString(),
    amount: 12000,
    status: 'completed',
    createdAt: new Date(),
    ...overrides,
  };
}

test('getAdminStats returns accurate counts', async () => {
  const database = createMemoryDatabase({
    users: [
      userRecord(new ObjectId().toHexString(), { role: 'vendor' }),
      userRecord(new ObjectId().toHexString(), { role: 'vendor' }),
      userRecord(new ObjectId().toHexString(), { role: 'customer' }),
      userRecord(new ObjectId().toHexString(), { role: 'admin' }),
    ],
    services: [
      serviceRecord(),
      serviceRecord({ _id: new ObjectId(), status: 'Approved' }),
      serviceRecord({ _id: new ObjectId(), status: 'Rejected' }),
      serviceRecord({ _id: new ObjectId(), status: 'Pending' }),
    ],
    transactions: [transactionRecord(), transactionRecord({ _id: new ObjectId() })],
  });

  const stats = await getAdminStats(database);

  assert.equal(stats.totalRegisteredUsers, 4);
  assert.equal(stats.totalVendors, 2);
  assert.equal(stats.totalCustomers, 1);
  assert.equal(stats.totalServices, 4);
  assert.equal(stats.pendingServices, 2);
  assert.equal(stats.totalTransactions, 2);
});

test('getAdminStats returns zeros for empty database', async () => {
  const database = createMemoryDatabase({
    users: [],
    services: [],
    transactions: [],
  });

  const stats = await getAdminStats(database);

  assert.equal(stats.totalRegisteredUsers, 0);
  assert.equal(stats.totalVendors, 0);
  assert.equal(stats.totalCustomers, 0);
  assert.equal(stats.totalServices, 0);
  assert.equal(stats.pendingServices, 0);
  assert.equal(stats.totalTransactions, 0);
});

test('getAdminStats counts only pending services', async () => {
  const database = createMemoryDatabase({
    users: [],
    services: [
      serviceRecord({ status: 'Pending' }),
      serviceRecord({ _id: new ObjectId(), status: 'Pending' }),
      serviceRecord({ _id: new ObjectId(), status: 'Approved' }),
      serviceRecord({ _id: new ObjectId(), status: 'Rejected' }),
    ],
    transactions: [],
  });

  const stats = await getAdminStats(database);

  assert.equal(stats.totalServices, 4);
  assert.equal(stats.pendingServices, 2);
});

test('getAdminStats handles database errors', async () => {
  const database = {
    collection: () => {
      throw new Error('Database connection failed');
    },
  } as unknown as Db;

  await assert.rejects(() => getAdminStats(database), Error);
});
