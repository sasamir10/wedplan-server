import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Db } from 'mongodb';
import {
  bookingStatuses,
  type BookingStatus,
  bookingStatusSchema,
  createBookingSchema,
} from '../src/models/booking.js';
import { ensureBookingIndexes } from '../src/config/database.js';

test('booking statuses contain exactly four permitted values', () => {
  assert.deepEqual(bookingStatuses, ['Pending', 'Accepted', 'Rejected', 'Cancelled']);
});

test('every booking status is a valid BookingStatus union member', () => {
  const statuses: readonly BookingStatus[] = bookingStatuses;
  assert.equal(statuses.length, 4);
});

test('booking status schema accepts all four statuses', () => {
  for (const status of bookingStatuses) {
    assert.equal(bookingStatusSchema.safeParse(status).success, true);
  }
});

test('booking status schema rejects invalid statuses', () => {
  assert.equal(bookingStatusSchema.safeParse('Approved').success, false);
  assert.equal(bookingStatusSchema.safeParse('pending').success, false);
  assert.equal(bookingStatusSchema.safeParse('').success, false);
  assert.equal(bookingStatusSchema.safeParse(null).success, false);
});

test('create booking schema accepts valid input', () => {
  const valid = {
    serviceId: '6b01311fbff14dc2fcc15476',
    eventDate: '2027-06-15',
    eventLocation: 'Dhaka',
    message: 'Please bring a vegetarian cake.',
  };
  assert.equal(createBookingSchema.safeParse(valid).success, true);
});

test('create booking schema accepts valid leap year date', () => {
  const valid = {
    serviceId: '6b01311fbff14dc2fcc15476',
    eventDate: '2028-02-29',
    eventLocation: 'Dhaka',
  };
  assert.equal(createBookingSchema.safeParse(valid).success, true);
});

test('create booking schema accepts input without optional message', () => {
  const valid = {
    serviceId: '6b01311fbff14dc2fcc15476',
    eventDate: '2027-06-15',
    eventLocation: 'Dhaka',
  };
  const result = createBookingSchema.safeParse(valid);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.message, undefined);
  }
});

test('create booking schema rejects missing required fields', () => {
  assert.equal(createBookingSchema.safeParse({}).success, false);
  assert.equal(
    createBookingSchema.safeParse({ eventDate: '2027-06-15', eventLocation: 'Dhaka' }).success,
    false,
  );
  assert.equal(
    createBookingSchema.safeParse({
      serviceId: '6b01311fbff14dc2fcc15476',
      eventLocation: 'Dhaka',
    }).success,
    false,
  );
  assert.equal(
    createBookingSchema.safeParse({
      serviceId: '6b01311fbff14dc2fcc15476',
      eventDate: '2027-06-15',
    }).success,
    false,
  );
});

test('create booking schema rejects invalid serviceId', () => {
  assert.equal(
    createBookingSchema.safeParse({
      serviceId: 'not-an-object-id',
      eventDate: '2027-06-15',
      eventLocation: 'Dhaka',
    }).success,
    false,
  );
  assert.equal(
    createBookingSchema.safeParse({
      serviceId: '6b01311fbff14dc2fcc1547',
      eventDate: '2027-06-15',
      eventLocation: 'Dhaka',
    }).success,
    false,
  );
  assert.equal(
    createBookingSchema.safeParse({
      serviceId: '6b01311fbff14dc2fcc15476G',
      eventDate: '2027-06-15',
      eventLocation: 'Dhaka',
    }).success,
    false,
  );
});

test('create booking schema rejects invalid eventDate format', () => {
  assert.equal(
    createBookingSchema.safeParse({
      serviceId: '6b01311fbff14dc2fcc15476',
      eventDate: '2027/06/15',
      eventLocation: 'Dhaka',
    }).success,
    false,
  );
  assert.equal(
    createBookingSchema.safeParse({
      serviceId: '6b01311fbff14dc2fcc15476',
      eventDate: 'June 15, 2027',
      eventLocation: 'Dhaka',
    }).success,
    false,
  );
  assert.equal(
    createBookingSchema.safeParse({
      serviceId: '6b01311fbff14dc2fcc15476',
      eventDate: '',
      eventLocation: 'Dhaka',
    }).success,
    false,
  );
});

test('create booking schema rejects impossible calendar dates', () => {
  const impossibleDates = ['2027-02-31', '2026-13-10', '2026-04-31', '2023-02-29', '2026-02-30'];
  for (const date of impossibleDates) {
    const result = createBookingSchema.safeParse({
      serviceId: '6b01311fbff14dc2fcc15476',
      eventDate: date,
      eventLocation: 'Dhaka',
    });
    assert.equal(result.success, false, `${date} should be rejected`);
  }
});

test('create booking schema accepts valid leap-year date and rejects invalid leap-year date', () => {
  const leapValid = createBookingSchema.safeParse({
    serviceId: '6b01311fbff14dc2fcc15476',
    eventDate: '2024-02-29',
    eventLocation: 'Dhaka',
  });
  assert.equal(leapValid.success, true, '2024-02-29 is a valid leap-year date');

  const leapInvalid = createBookingSchema.safeParse({
    serviceId: '6b01311fbff14dc2fcc15476',
    eventDate: '2023-02-29',
    eventLocation: 'Dhaka',
  });
  assert.equal(leapInvalid.success, false, '2023-02-29 is not a valid leap-year date');
});

test('create booking schema rejects empty eventLocation', () => {
  assert.equal(
    createBookingSchema.safeParse({
      serviceId: '6b01311fbff14dc2fcc15476',
      eventDate: '2027-06-15',
      eventLocation: '   ',
    }).success,
    false,
  );
});

test('create booking schema trims eventLocation and optional message', () => {
  const result = createBookingSchema.safeParse({
    serviceId: '6b01311fbff14dc2fcc15476',
    eventDate: '2027-06-15',
    eventLocation: '  Dhaka  ',
    message: '  Hello  ',
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.eventLocation, 'Dhaka');
    assert.equal(result.data.message, 'Hello');
  }
});

type CapturedIndex = {
  key: Record<string, unknown>;
  name: string;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
};

function createIndexCaptureDatabase() {
  const captured: CapturedIndex[] = [];

  const database = {
    collection: () => ({
      createIndexes: async (
        specs: Array<{
          key: Record<string, unknown>;
          name: string;
          unique?: boolean;
          partialFilterExpression?: Record<string, unknown>;
        }>,
      ) => {
        for (const spec of specs) {
          captured.push({
            key: spec.key,
            name: spec.name,
            unique: spec.unique,
            partialFilterExpression: spec.partialFilterExpression,
          });
        }
      },
    }),
  };

  return { database: database as unknown as Db, captured };
}

test('ensureBookingIndexes creates all four expected indexes', async () => {
  const { database, captured } = createIndexCaptureDatabase();
  await ensureBookingIndexes(database);
  assert.equal(captured.length, 4);

  const names = captured.map((entry) => entry.name);
  assert.ok(names.includes('idx_bookings_customer_status'));
  assert.ok(names.includes('idx_bookings_vendor_status'));
  assert.ok(names.includes('idx_bookings_service_date_unique_active'));
  assert.ok(names.includes('idx_bookings_created_at_desc'));
});

test('customer and vendor indexes use correct key patterns', async () => {
  const { database, captured } = createIndexCaptureDatabase();
  await ensureBookingIndexes(database);

  const customerIndex = captured.find((entry) => entry.name === 'idx_bookings_customer_status');
  assert.ok(customerIndex, 'customer index should exist');
  assert.deepEqual(customerIndex.key, { customerId: 1, status: 1 });

  const vendorIndex = captured.find((entry) => entry.name === 'idx_bookings_vendor_status');
  assert.ok(vendorIndex, 'vendor index should exist');
  assert.deepEqual(vendorIndex.key, { vendorId: 1, status: 1 });
});

test('createdAt index sorts recent bookings first', async () => {
  const { database, captured } = createIndexCaptureDatabase();
  await ensureBookingIndexes(database);

  const createdAtIndex = captured.find((entry) => entry.name === 'idx_bookings_created_at_desc');
  assert.ok(createdAtIndex, 'createdAt index should exist');
  assert.deepEqual(createdAtIndex.key, { createdAt: -1 });
});

test('duplicate prevention index is unique and partially filtered to Pending and Accepted', async () => {
  const { database, captured } = createIndexCaptureDatabase();
  await ensureBookingIndexes(database);

  const duplicateIndex = captured.find(
    (entry) => entry.name === 'idx_bookings_service_date_unique_active',
  );
  assert.ok(duplicateIndex, 'duplicate prevention index should exist');
  assert.deepEqual(duplicateIndex.key, { serviceId: 1, eventDate: 1 });
  assert.equal(duplicateIndex.unique, true);
  assert.deepEqual(duplicateIndex.partialFilterExpression, {
    status: { $in: ['Pending', 'Accepted'] },
  });
});

test('ensureBookingIndexes is idempotent and does not throw on repeated calls', async () => {
  const { database, captured } = createIndexCaptureDatabase();
  await ensureBookingIndexes(database);
  const firstCallCount = captured.length;
  assert.equal(firstCallCount, 4);

  await ensureBookingIndexes(database);
  assert.equal(captured.length, firstCallCount * 2, 'second call invokes createIndexes without error');
});
