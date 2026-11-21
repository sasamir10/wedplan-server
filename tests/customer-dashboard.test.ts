import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId, type Db } from 'mongodb';
import { getCustomerStats } from '../src/services/customer-dashboard.service.js';
import { AppError } from '../src/utils/app-error.js';

type MemoryDocument = Record<string, unknown> & { _id: string | ObjectId };

const customerOneObjectId = new ObjectId();
const CUSTOMER_ONE_ID = customerOneObjectId.toHexString();
const CUSTOMER_TWO_ID = new ObjectId().toHexString();

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
  bookings: MemoryDocument[];
}) {
  const bookings = [...overrides.bookings];

  const database = {
    collection(name: string) {
      if (name === 'bookings') {
        return {
          countDocuments: async (filter: Record<string, unknown>) =>
            bookings.filter((booking) => matches(booking, filter)).length,
        };
      }

      throw new Error(`Unexpected collection: ${name}`);
    },
  };

  return database as unknown as Db;
}

function bookingRecord(overrides: Record<string, unknown> = {}) {
  return {
    _id: new ObjectId(),
    customerId: CUSTOMER_ONE_ID,
    vendorId: new ObjectId().toHexString(),
    serviceId: new ObjectId().toHexString(),
    eventDate: '2027-06-15',
    eventLocation: 'Dhaka',
    message: 'Test booking',
    status: 'Pending',
    createdAt: new Date(),
    ...overrides,
  };
}

test('getCustomerStats returns accurate total booking count', async () => {
  const database = createMemoryDatabase({
    bookings: [
      bookingRecord(),
      bookingRecord({ _id: new ObjectId() }),
      bookingRecord({ _id: new ObjectId(), customerId: CUSTOMER_TWO_ID }),
    ],
  });

  const stats = await getCustomerStats(database, CUSTOMER_ONE_ID);

  assert.equal(stats.totalBookingRequests, 2);
});

test('getCustomerStats counts only the authenticated customer bookings', async () => {
  const database = createMemoryDatabase({
    bookings: [
      bookingRecord(),
      bookingRecord({ _id: new ObjectId() }),
      bookingRecord({ _id: new ObjectId(), customerId: CUSTOMER_TWO_ID }),
      bookingRecord({ _id: new ObjectId(), customerId: CUSTOMER_TWO_ID }),
    ],
  });

  const stats = await getCustomerStats(database, CUSTOMER_ONE_ID);

  assert.equal(stats.totalBookingRequests, 2);
});

test('getCustomerStats counts pending bookings', async () => {
  const database = createMemoryDatabase({
    bookings: [
      bookingRecord(),
      bookingRecord({ _id: new ObjectId(), status: 'Pending' }),
      bookingRecord({ _id: new ObjectId(), status: 'Accepted' }),
      bookingRecord({ _id: new ObjectId(), status: 'Rejected' }),
      bookingRecord({ _id: new ObjectId(), customerId: CUSTOMER_TWO_ID }),
    ],
  });

  const stats = await getCustomerStats(database, CUSTOMER_ONE_ID);

  assert.equal(stats.pendingBookings, 2);
});

test('getCustomerStats counts accepted bookings', async () => {
  const database = createMemoryDatabase({
    bookings: [
      bookingRecord(),
      bookingRecord({ _id: new ObjectId(), status: 'Pending' }),
      bookingRecord({ _id: new ObjectId(), status: 'Accepted' }),
      bookingRecord({ _id: new ObjectId(), status: 'Accepted' }),
      bookingRecord({ _id: new ObjectId(), customerId: CUSTOMER_TWO_ID }),
    ],
  });

  const stats = await getCustomerStats(database, CUSTOMER_ONE_ID);

  assert.equal(stats.acceptedBookings, 2);
});

test('getCustomerStats counts rejected bookings', async () => {
  const database = createMemoryDatabase({
    bookings: [
      bookingRecord(),
      bookingRecord({ _id: new ObjectId(), status: 'Pending' }),
      bookingRecord({ _id: new ObjectId(), status: 'Accepted' }),
      bookingRecord({ _id: new ObjectId(), status: 'Rejected' }),
      bookingRecord({ _id: new ObjectId(), status: 'Rejected' }),
      bookingRecord({ _id: new ObjectId(), customerId: CUSTOMER_TWO_ID }),
    ],
  });

  const stats = await getCustomerStats(database, CUSTOMER_ONE_ID);

  assert.equal(stats.rejectedBookings, 2);
});

test('getCustomerStats includes cancelled bookings in total but not in status counts', async () => {
  const database = createMemoryDatabase({
    bookings: [
      bookingRecord(),
      bookingRecord({ _id: new ObjectId(), status: 'Cancelled' }),
      bookingRecord({ _id: new ObjectId(), status: 'Cancelled' }),
    ],
  });

  const stats = await getCustomerStats(database, CUSTOMER_ONE_ID);

  assert.equal(stats.totalBookingRequests, 3);
  assert.equal(stats.pendingBookings, 1);
  assert.equal(stats.acceptedBookings, 0);
  assert.equal(stats.rejectedBookings, 0);
});

test('getCustomerStats returns zeros for empty database', async () => {
  const database = createMemoryDatabase({ bookings: [] });

  const stats = await getCustomerStats(database, CUSTOMER_ONE_ID);

  assert.equal(stats.totalBookingRequests, 0);
  assert.equal(stats.pendingBookings, 0);
  assert.equal(stats.acceptedBookings, 0);
  assert.equal(stats.rejectedBookings, 0);
});

test('getCustomerStats throws when customerId is not a valid ObjectId hex', async () => {
  const database = createMemoryDatabase({ bookings: [] });

  await assert.rejects(
    () => getCustomerStats(database, 'not-a-valid-object-id'),
    { statusCode: 403, code: 'CUSTOMER_NOT_FOUND' },
  );
});

test('getCustomerStats counts all statuses correctly for mixed bookings', async () => {
  const database = createMemoryDatabase({
    bookings: [
      bookingRecord(), // Pending
      bookingRecord({ _id: new ObjectId(), status: 'Pending' }),
      bookingRecord({ _id: new ObjectId(), status: 'Accepted' }),
      bookingRecord({ _id: new ObjectId(), status: 'Accepted' }),
      bookingRecord({ _id: new ObjectId(), status: 'Rejected' }),
      bookingRecord({ _id: new ObjectId(), status: 'Rejected' }),
      bookingRecord({ _id: new ObjectId(), status: 'Cancelled' }),
      bookingRecord({ _id: new ObjectId(), customerId: CUSTOMER_TWO_ID }),
    ],
  });

  const stats = await getCustomerStats(database, CUSTOMER_ONE_ID);

  assert.equal(stats.totalBookingRequests, 7);
  assert.equal(stats.pendingBookings, 2);
  assert.equal(stats.acceptedBookings, 2);
  assert.equal(stats.rejectedBookings, 2);
});
