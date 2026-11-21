import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId, type Db } from 'mongodb';
import { getVendorStats } from '../src/services/vendor-dashboard.service.js';
import { AppError } from '../src/utils/app-error.js';

type MemoryDocument = Record<string, unknown> & { _id: string | ObjectId };

const vendorOneObjectId = new ObjectId();
const VENDOR_ONE_ID = vendorOneObjectId.toHexString();
const VENDOR_TWO_ID = new ObjectId().toHexString();

function createMemoryDatabase(overrides: {
  services: MemoryDocument[];
  bookings: MemoryDocument[];
  users: MemoryDocument[];
}) {
  const services = [...overrides.services];
  const bookings = [...overrides.bookings];
  const users = [...overrides.users];

  function matches(document: MemoryDocument, filter: Record<string, unknown>): boolean {
    return Object.entries(filter).every(([key, value]) => {
      const actual = document[key];
      if (actual instanceof ObjectId && value instanceof ObjectId) {
        return actual.equals(value);
      }
      return actual === value;
    });
  }

  const database = {
    collection(name: string) {
      if (name === 'services') {
        return {
          countDocuments: async (filter: Record<string, unknown>) =>
            services.filter((service) => matches(service, filter)).length,
        };
      }

      if (name === 'bookings') {
        return {
          countDocuments: async (filter: Record<string, unknown>) =>
            bookings.filter((booking) => matches(booking, filter)).length,
        };
      }

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
        };
      }

      throw new Error(`Unexpected collection: ${name}`);
    },
  };

  return database as unknown as Db;
}

function serviceRecord(overrides: Record<string, unknown> = {}) {
  return {
    _id: new ObjectId(),
    vendorId: VENDOR_ONE_ID,
    serviceName: 'Wedding Photography',
    category: 'Photography & Videography',
    description: 'Professional wedding photography',
    price: 12000,
    location: 'Dhaka',
    images: ['https://example.com/photo.jpg'],
    status: 'Approved',
    availability: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function bookingRecord(overrides: Record<string, unknown> = {}) {
  return {
    _id: new ObjectId(),
    vendorId: VENDOR_ONE_ID,
    customerId: new ObjectId().toHexString(),
    serviceId: new ObjectId().toHexString(),
    eventDate: '2027-06-15',
    eventLocation: 'Dhaka',
    message: 'Test booking',
    status: 'Pending',
    createdAt: new Date(),
    ...overrides,
  };
}

function userRecord(
  idHex: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    _id: new ObjectId(idHex),
    name: 'Test Vendor',
    email: 'vendor@example.com',
    role: 'vendor',
    isBlocked: false,
    subscriptionPlan: 'free',
    ...overrides,
  };
}

test('getVendorStats returns accurate total service count', async () => {
  const database = createMemoryDatabase({
    services: [
      serviceRecord(),
      serviceRecord({ _id: new ObjectId() }),
      serviceRecord({ _id: new ObjectId(), vendorId: VENDOR_TWO_ID }),
    ],
    bookings: [],
    users: [userRecord(VENDOR_ONE_ID)],
  });

  const stats = await getVendorStats(database, VENDOR_ONE_ID);

  assert.equal(stats.totalServices, 2);
});

test('getVendorStats counts only the authenticated vendor services', async () => {
  const database = createMemoryDatabase({
    services: [
      serviceRecord(),
      serviceRecord({ _id: new ObjectId() }),
      serviceRecord({ _id: new ObjectId(), vendorId: VENDOR_TWO_ID }),
      serviceRecord({ _id: new ObjectId(), vendorId: VENDOR_TWO_ID }),
    ],
    bookings: [],
    users: [userRecord(VENDOR_ONE_ID), userRecord(VENDOR_TWO_ID)],
  });

  const stats = await getVendorStats(database, VENDOR_ONE_ID);

  assert.equal(stats.totalServices, 2);
  assert.equal(stats.activeServices, 2);
});

test('getVendorStats active service count uses availability true', async () => {
  const database = createMemoryDatabase({
    services: [
      serviceRecord(),
      serviceRecord({
        _id: new ObjectId(),
        availability: false,
      }),
      serviceRecord({
        _id: new ObjectId(),
        availability: true,
      }),
      serviceRecord({
        _id: new ObjectId(),
        vendorId: VENDOR_TWO_ID,
        availability: true,
      }),
    ],
    bookings: [],
    users: [userRecord(VENDOR_ONE_ID)],
  });

  const stats = await getVendorStats(database, VENDOR_ONE_ID);

  assert.equal(stats.totalServices, 3);
  assert.equal(stats.activeServices, 2);
});

test('getVendorStats counts pending booking requests', async () => {
  const database = createMemoryDatabase({
    services: [],
    bookings: [
      bookingRecord(),
      bookingRecord({ _id: new ObjectId(), status: 'Pending' }),
      bookingRecord({ _id: new ObjectId(), status: 'Accepted' }),
      bookingRecord({ _id: new ObjectId(), status: 'Rejected' }),
      bookingRecord({ _id: new ObjectId(), vendorId: VENDOR_TWO_ID }),
    ],
    users: [userRecord(VENDOR_ONE_ID)],
  });

  const stats = await getVendorStats(database, VENDOR_ONE_ID);

  assert.equal(stats.pendingBookingRequests, 2);
});

test('getVendorStats counts accepted bookings', async () => {
  const database = createMemoryDatabase({
    services: [],
    bookings: [
      bookingRecord(),
      bookingRecord({ _id: new ObjectId(), status: 'Pending' }),
      bookingRecord({ _id: new ObjectId(), status: 'Accepted' }),
      bookingRecord({ _id: new ObjectId(), status: 'Accepted' }),
      bookingRecord({ _id: new ObjectId(), vendorId: VENDOR_TWO_ID }),
    ],
    users: [userRecord(VENDOR_ONE_ID)],
  });

  const stats = await getVendorStats(database, VENDOR_ONE_ID);

  assert.equal(stats.acceptedBookings, 2);
});

test('getVendorStats derives subscription plan from user record', async () => {
  const database = createMemoryDatabase({
    services: [],
    bookings: [],
    users: [
      userRecord(VENDOR_ONE_ID, { subscriptionPlan: 'premium' }),
    ],
  });

  const stats = await getVendorStats(database, VENDOR_ONE_ID);

  assert.equal(stats.subscriptionPlan, 'premium');
});

test('getVendorStats defaults missing subscription to free', async () => {
  const database = createMemoryDatabase({
    services: [],
    bookings: [],
    users: [
      {
        _id: vendorOneObjectId,
        name: 'Test Vendor',
        role: 'vendor',
        // no subscriptionPlan field
      },
    ],
  });

  const stats = await getVendorStats(database, VENDOR_ONE_ID);

  assert.equal(stats.subscriptionPlan, 'free');
});

test('getVendorStats returns zeros for empty database', async () => {
  const database = createMemoryDatabase({
    services: [],
    bookings: [],
    users: [userRecord(VENDOR_ONE_ID)],
  });

  const stats = await getVendorStats(database, VENDOR_ONE_ID);

  assert.equal(stats.totalServices, 0);
  assert.equal(stats.activeServices, 0);
  assert.equal(stats.pendingBookingRequests, 0);
  assert.equal(stats.acceptedBookings, 0);
  assert.equal(stats.subscriptionPlan, 'free');
});

test('getVendorStats throws when vendor user record not found', async () => {
  const database = createMemoryDatabase({
    services: [],
    bookings: [],
    users: [],
  });

  await assert.rejects(
    () => getVendorStats(database, VENDOR_ONE_ID),
    { statusCode: 403, code: 'VENDOR_NOT_FOUND' },
  );
});

test('getVendorStats throws when vendorId is not a valid ObjectId hex', async () => {
  const database = createMemoryDatabase({
    services: [],
    bookings: [],
    users: [userRecord(VENDOR_ONE_ID)],
  });

  await assert.rejects(
    () => getVendorStats(database, 'not-a-valid-object-id'),
    { statusCode: 403, code: 'VENDOR_NOT_FOUND' },
  );
});

test('getVendorStats rejects unknown subscription plan values', async () => {
  const database = createMemoryDatabase({
    services: [],
    bookings: [],
    users: [
      userRecord(VENDOR_ONE_ID, { subscriptionPlan: 'invalid-plan' }),
    ],
  });

  const stats = await getVendorStats(database, VENDOR_ONE_ID);

  assert.equal(stats.subscriptionPlan, 'free');
});
