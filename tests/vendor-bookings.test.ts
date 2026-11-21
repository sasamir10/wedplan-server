import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId, type Db } from 'mongodb';
import { vendorBookingQuerySchema } from '../src/models/booking.js';
import {
  acceptBooking,
  getVendorBookings,
  rejectBooking,
} from '../src/services/booking.service.js';
import { AppError } from '../src/utils/app-error.js';

type MemoryDocument = Record<string, unknown> & { _id: string | ObjectId };

function matches(document: MemoryDocument, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => {
    const actual = document[key];
    if (actual instanceof ObjectId && value instanceof ObjectId) {
      return actual.equals(value);
    }
    if (value !== null && typeof value === 'object' && '$in' in value) {
      const allowed = (value as { $in: unknown[] }).$in;
      if (!Array.isArray(allowed)) return false;
      return allowed.some((allowedValue) => {
        if (actual instanceof ObjectId && allowedValue instanceof ObjectId) {
          return actual.equals(allowedValue);
        }
        return actual === allowedValue;
      });
    }
    return actual === value;
  });
}

function createMemoryDatabase(overrides: {
  bookings: MemoryDocument[];
  users: MemoryDocument[];
}) {
  const bookings = [...overrides.bookings];
  const users = [...overrides.users];

  const database = {
    collection(name: string) {
      if (name === 'bookings') {
        return {
          findOne: async (filter: Record<string, unknown>) =>
            bookings.find((booking) => matches(booking, filter)) ?? null,
          find: (filter: Record<string, unknown>) => {
            let result = bookings.filter((booking) => matches(booking, filter));
            let sortField: string | null = null;
            let sortOrder = 1;
            const chain: Record<string, unknown> = {
              sort: (spec: Record<string, unknown>) => {
                const [field, order] = Object.entries(spec)[0];
                sortField = field as string;
                sortOrder = Number(order) === -1 ? -1 : 1;
                return chain;
              },
              skip: (n: number) => {
                result = result.slice(Number(n));
                return chain;
              },
              limit: (n: number) => {
                result = result.slice(0, Number(n));
                return chain;
              },
              toArray: async () => {
                if (sortField) {
                  result = [...result].sort((a, b) => {
                    const av = a[sortField as keyof MemoryDocument];
                    const bv = b[sortField as keyof MemoryDocument];
                    if (av instanceof Date && bv instanceof Date) {
                      return sortOrder * (av.getTime() - bv.getTime());
                    }
                    return 0;
                  });
                }
                return result;
              },
            };
            return chain;
          },
          countDocuments: async (filter: Record<string, unknown>) =>
            bookings.filter((booking) => matches(booking, filter)).length,
          insertOne: async (booking: MemoryDocument) => {
            bookings.push(booking);
            return { insertedId: booking._id };
          },
          findOneAndUpdate: async (
            filter: Record<string, unknown>,
            update: { $set: Record<string, unknown> },
            options?: { returnDocument?: string },
          ) => {
            const booking = bookings.find((entry) => matches(entry, filter));
            if (!booking) return null;
            Object.assign(booking, update.$set);
            return booking;
          },
        };
      }

      if (name === 'user') {
        return {
          findOne: async (
            filter: Record<string, unknown>,
            options?: { projection?: Record<string, unknown> },
          ) => {
            const user = users.find((entry) => matches(entry, filter)) ?? null;
            if (!user || !options?.projection) return user;
            const projected: Record<string, unknown> = {};
            for (const [key, include] of Object.entries(options.projection)) {
              if (include === 1 && key !== '_id') {
                projected[key] = user[key];
              }
            }
            return projected;
          },
          find: (filter: Record<string, unknown>) => {
            const result = users.filter((user) => matches(user, filter));
            return {
              project: () => ({ toArray: async () => result }),
              toArray: async () => result,
            };
          },
        };
      }

      throw new Error(`Unexpected collection: ${name}`);
    },
  };

  return {
    database: database as unknown as Db,
    bookings,
    users,
  };
}

const VENDOR_ID = '6b01311fbff14dc2fcc15477';
const OTHER_VENDOR_ID = '6b01311fbff14dc2fcc15478';
const CUSTOMER_ID = '6b01311fbff14dc2fcc15476';

function bookingRecord(overrides: Record<string, unknown> = {}) {
  return {
    _id: new ObjectId(),
    vendorId: VENDOR_ID,
    customerId: CUSTOMER_ID,
    serviceId: '6b01b9b8df51aa9a3daa485b',
    eventDate: '2027-06-15',
    eventLocation: 'Dhaka',
    message: 'Test booking',
    status: 'Pending',
    createdAt: new Date(),
    serviceSnapshot: {
      serviceName: 'Wedding Photography',
      category: 'Photography & Videography',
      image: 'https://i.ibb.co/abc123/photo.jpg',
      price: 1200,
      vendor: { name: 'John Vendor', businessName: 'Johns Weddings' },
    },
    ...overrides,
  };
}

function userRecord(idHex: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: new ObjectId(idHex),
    name: 'Jane Customer',
    image: 'https://i.ibb.co/cust123/photo.jpg',
    ...overrides,
  };
}

test('vendor booking query schema accepts valid input', () => {
  assert.equal(
    vendorBookingQuerySchema.safeParse({ status: 'Pending', page: '1', limit: '10' }).success,
    true,
  );
  assert.equal(
    vendorBookingQuerySchema.safeParse({}).success,
    true,
  );
});

test('vendor booking query schema defaults page and limit', () => {
  const result = vendorBookingQuerySchema.safeParse({});
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.page, 1);
    assert.equal(result.data.limit, 10);
  }
});

test('vendor booking query schema rejects invalid status', () => {
  assert.equal(
    vendorBookingQuerySchema.safeParse({ status: 'Invalid' }).success,
    false,
  );
});

test('vendor booking list returns only bookings for the authenticated vendor', async () => {
  const ownBooking = bookingRecord({ vendorId: VENDOR_ID });
  const otherBooking = bookingRecord({ vendorId: OTHER_VENDOR_ID, _id: new ObjectId() });
  const { database } = createMemoryDatabase({
    bookings: [ownBooking, otherBooking],
    users: [userRecord(CUSTOMER_ID)],
  });

  const result = await getVendorBookings(database, {
    vendorId: VENDOR_ID,
    page: 1,
    limit: 10,
  });

  assert.equal(result.bookings.length, 1);
  assert.equal(result.bookings[0]!.vendorId, VENDOR_ID);
  assert.equal(result.pagination.total, 1);
});

test('vendor booking list does not accept client-supplied vendor ID override', async () => {
  const { database } = createMemoryDatabase({ bookings: [], users: [] });
  const result = await getVendorBookings(database, {
    vendorId: VENDOR_ID,
    page: 1,
    limit: 10,
  });
  assert.equal(result.bookings.length, 0);
});

test('vendor booking list filters by status', async () => {
  const pendingBooking = bookingRecord({ status: 'Pending' });
  const acceptedBooking = bookingRecord({
    _id: new ObjectId(),
    status: 'Accepted',
  });
  const { database } = createMemoryDatabase({
    bookings: [pendingBooking, acceptedBooking],
    users: [userRecord(CUSTOMER_ID)],
  });

  const result = await getVendorBookings(database, {
    vendorId: VENDOR_ID,
    status: 'Pending',
    page: 1,
    limit: 10,
  });

  assert.equal(result.bookings.length, 1);
  assert.equal(result.bookings[0]!.status, 'Pending');
});

test('vendor booking query schema rejects invalid status filter', () => {
  assert.equal(
    vendorBookingQuerySchema.safeParse({ status: 'Invalid' }).success,
    false,
  );
});

test('vendor booking list supports pagination', async () => {
  const bookings = [
    bookingRecord(),
    bookingRecord({ _id: new ObjectId() }),
    bookingRecord({ _id: new ObjectId() }),
  ];
  const { database } = createMemoryDatabase({
    bookings,
    users: [userRecord(CUSTOMER_ID)],
  });

  const result = await getVendorBookings(database, {
    vendorId: VENDOR_ID,
    page: 1,
    limit: 2,
  });

  assert.equal(result.bookings.length, 2);
  assert.equal(result.pagination.page, 1);
  assert.equal(result.pagination.limit, 2);
  assert.equal(result.pagination.total, 3);
  assert.equal(result.pagination.totalPages, 2);
});

test('vendor booking list sorts newest first', async () => {
  const older = bookingRecord({ _id: new ObjectId(), createdAt: new Date('2027-01-01') });
  const newer = bookingRecord({ _id: new ObjectId(), createdAt: new Date('2027-06-01') });
  const { database } = createMemoryDatabase({
    bookings: [older, newer],
    users: [userRecord(CUSTOMER_ID)],
  });

  const result = await getVendorBookings(database, {
    vendorId: VENDOR_ID,
    page: 1,
    limit: 10,
  });

  assert.equal(result.bookings.length, 2);
  assert.equal(result.bookings[0]!.createdAt.getTime(), newer.createdAt.getTime());
});

test('vendor booking list includes safe customer display information', async () => {
  const booking = bookingRecord();
  const customer = userRecord(CUSTOMER_ID, { email: 'jane@example.com', password: 'secret' });
  const { database } = createMemoryDatabase({
    bookings: [booking],
    users: [customer],
  });

  const result = await getVendorBookings(database, {
    vendorId: VENDOR_ID,
    page: 1,
    limit: 10,
  });

  assert.equal(result.bookings.length, 1);
  assert.equal(result.bookings[0]!.customer?.name, 'Jane Customer');
  assert.equal(result.bookings[0]!.customer?.image, 'https://i.ibb.co/cust123/photo.jpg');
  assert.equal((result.bookings[0]!.customer as any)?.email, undefined);
  assert.equal((result.bookings[0]!.customer as any)?.password, undefined);
});

test('vendor booking list includes historical service snapshot', async () => {
  const booking = bookingRecord();
  const { database } = createMemoryDatabase({
    bookings: [booking],
    users: [userRecord(CUSTOMER_ID)],
  });

  const result = await getVendorBookings(database, {
    vendorId: VENDOR_ID,
    page: 1,
    limit: 10,
  });

  assert.ok(result.bookings[0]!.serviceSnapshot);
  assert.equal(result.bookings[0]!.serviceSnapshot!.serviceName, 'Wedding Photography');
  assert.equal(result.bookings[0]!.serviceSnapshot!.category, 'Photography & Videography');
  assert.equal(result.bookings[0]!.serviceSnapshot!.price, 1200);
});

test('vendor booking list handles missing customer records safely', async () => {
  const booking = bookingRecord();
  const { database } = createMemoryDatabase({
    bookings: [booking],
    users: [],
  });

  const result = await getVendorBookings(database, {
    vendorId: VENDOR_ID,
    page: 1,
    limit: 10,
  });

  assert.equal(result.bookings.length, 1);
  assert.equal(result.bookings[0]!.customer, null);
});

test('vendor booking list returns empty result when no bookings exist', async () => {
  const { database } = createMemoryDatabase({ bookings: [], users: [] });

  const result = await getVendorBookings(database, {
    vendorId: VENDOR_ID,
    page: 1,
    limit: 10,
  });

  assert.equal(result.bookings.length, 0);
  assert.equal(result.pagination.total, 0);
  assert.equal(result.pagination.totalPages, 0);
});

test('accept booking transitions Pending to Accepted', async () => {
  const booking = bookingRecord();
  const { database, bookings } = createMemoryDatabase({
    bookings: [booking],
    users: [userRecord(CUSTOMER_ID)],
  });

  const result = await acceptBooking(database, booking._id.toHexString(), VENDOR_ID);

  assert.equal(result.status, 'Accepted');
  assert.equal(result.id, booking._id.toHexString());
  assert.equal(bookings[0]!.status, 'Accepted');
});

test('reject booking transitions Pending to Rejected', async () => {
  const booking = bookingRecord();
  const { database, bookings } = createMemoryDatabase({
    bookings: [booking],
    users: [userRecord(CUSTOMER_ID)],
  });

  const result = await rejectBooking(database, booking._id.toHexString(), VENDOR_ID);

  assert.equal(result.status, 'Rejected');
  assert.equal(result.id, booking._id.toHexString());
  assert.equal(bookings[0]!.status, 'Rejected');
});

test('accept already processed booking returns 409', async () => {
  const booking = bookingRecord({ status: 'Accepted' });
  const { database } = createMemoryDatabase({
    bookings: [booking],
    users: [userRecord(CUSTOMER_ID)],
  });

  await assert.rejects(
    () => acceptBooking(database, booking._id.toHexString(), VENDOR_ID),
    { statusCode: 409, code: 'BOOKING_ALREADY_PROCESSED' },
  );
});

test('reject already processed booking returns 409', async () => {
  const booking = bookingRecord({ status: 'Rejected' });
  const { database } = createMemoryDatabase({
    bookings: [booking],
    users: [userRecord(CUSTOMER_ID)],
  });

  await assert.rejects(
    () => rejectBooking(database, booking._id.toHexString(), VENDOR_ID),
    { statusCode: 409, code: 'BOOKING_ALREADY_PROCESSED' },
  );
});

test('accept cancelled booking returns 409', async () => {
  const booking = bookingRecord({ status: 'Cancelled' });
  const { database } = createMemoryDatabase({
    bookings: [booking],
    users: [userRecord(CUSTOMER_ID)],
  });

  await assert.rejects(
    () => acceptBooking(database, booking._id.toHexString(), VENDOR_ID),
    { statusCode: 409, code: 'BOOKING_ALREADY_PROCESSED' },
  );
});

test('reject cancelled booking returns 409', async () => {
  const booking = bookingRecord({ status: 'Cancelled' });
  const { database } = createMemoryDatabase({
    bookings: [booking],
    users: [userRecord(CUSTOMER_ID)],
  });

  await assert.rejects(
    () => rejectBooking(database, booking._id.toHexString(), VENDOR_ID),
    { statusCode: 409, code: 'BOOKING_ALREADY_PROCESSED' },
  );
});

test('accept another vendor booking returns 404', async () => {
  const booking = bookingRecord({ vendorId: OTHER_VENDOR_ID });
  const { database } = createMemoryDatabase({
    bookings: [booking],
    users: [userRecord(CUSTOMER_ID)],
  });

  await assert.rejects(
    () => acceptBooking(database, booking._id.toHexString(), VENDOR_ID),
    { statusCode: 404, code: 'BOOKING_NOT_FOUND' },
  );
});

test('reject another vendor booking returns 404', async () => {
  const booking = bookingRecord({ vendorId: OTHER_VENDOR_ID });
  const { database } = createMemoryDatabase({
    bookings: [booking],
    users: [userRecord(CUSTOMER_ID)],
  });

  await assert.rejects(
    () => rejectBooking(database, booking._id.toHexString(), VENDOR_ID),
    { statusCode: 404, code: 'BOOKING_NOT_FOUND' },
  );
});

test('accept invalid booking ID returns 400', async () => {
  const { database } = createMemoryDatabase({ bookings: [], users: [] });

  await assert.rejects(
    () => acceptBooking(database, 'not-an-object-id', VENDOR_ID),
    { statusCode: 400, code: 'INVALID_OBJECT_ID' },
  );
});

test('reject invalid booking ID returns 400', async () => {
  const { database } = createMemoryDatabase({ bookings: [], users: [] });

  await assert.rejects(
    () => rejectBooking(database, 'not-an-object-id', VENDOR_ID),
    { statusCode: 400, code: 'INVALID_OBJECT_ID' },
  );
});
