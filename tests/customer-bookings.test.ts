import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId, type Db } from 'mongodb';
import {
  createBookingSchema,
  customerBookingQuerySchema,
} from '../src/models/booking.js';
import {
  cancelBooking,
  createBooking,
  getCustomerBookings,
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
      return Array.isArray(allowed) && allowed.includes(actual);
    }
    return actual === value;
  });
}

function createMemoryDatabase(overrides: {
  services: MemoryDocument[];
  bookings: MemoryDocument[];
  users: MemoryDocument[];
}) {
  const services = [...overrides.services];
  const bookings = [...overrides.bookings];
  const users = [...overrides.users];

  const database = {
    collection(name: string) {
      if (name === 'services') {
        return {
          findOne: async (filter: Record<string, unknown>) =>
            services.find((service) => matches(service, filter)) ?? null,
        };
      }

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
        };
      }

      throw new Error(`Unexpected collection: ${name}`);
    },
  };

  return {
    database: database as unknown as Db,
    services,
    bookings,
    users,
  };
}

const CUSTOMER_ID = '6b01311fbff14dc2fcc15476';
const VENDOR_ID = '6b01311fbff14dc2fcc15477';

function serviceRecord(vendorId: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: new ObjectId(),
    vendorId,
    serviceName: 'Wedding Photography',
    category: 'Photography & Videography',
    description: 'Full day coverage',
    price: 1200,
    location: 'Dhaka',
    images: ['https://i.ibb.co/abc123/photo.jpg'],
    status: 'Approved',
    availability: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function userRecord(idHex: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: new ObjectId(idHex),
    name: 'John Vendor',
    businessName: 'Johns Weddings',
    ...overrides,
  };
}

const validInput = {
  serviceId: '6b01311fbff14dc2fcc15476',
  eventDate: '2027-06-15',
  eventLocation: 'Dhaka, Bangladesh',
  message: 'Outdoor wedding.',
};

test('create booking schema accepts valid input', () => {
  assert.equal(createBookingSchema.safeParse(validInput).success, true);
});

test('create booking schema rejects unexpected client-supplied fields', () => {
  assert.equal(
    createBookingSchema.safeParse({ ...validInput, customerId: 'client-id' }).success,
    false,
  );
  assert.equal(
    createBookingSchema.safeParse({ ...validInput, vendorId: 'client-vendor' }).success,
    false,
  );
  assert.equal(
    createBookingSchema.safeParse({ ...validInput, status: 'Accepted' }).success,
    false,
  );
  assert.equal(
    createBookingSchema.safeParse({ ...validInput, createdAt: '2027-01-01' }).success,
    false,
  );
  assert.equal(
    createBookingSchema.safeParse({ ...validInput, serviceSnapshot: {} }).success,
    false,
  );
});

test('creates a Pending booking for an authenticated customer', async () => {
  const service = serviceRecord(VENDOR_ID);
  const vendor = userRecord(VENDOR_ID);
  const { database, bookings } = createMemoryDatabase({
    services: [service],
    bookings: [],
    users: [vendor],
  });

  const result = await createBooking(database, CUSTOMER_ID, {
    ...validInput,
    serviceId: service._id.toHexString(),
  });

  assert.equal(result.status, 'Pending');
  assert.equal(result.customerId, CUSTOMER_ID);
  assert.equal(result.vendorId, VENDOR_ID);
  assert.equal(result.serviceId, service._id.toHexString());
  assert.equal(result.eventDate, '2027-06-15');
  assert.equal(result.eventLocation, 'Dhaka, Bangladesh');
  assert.equal(result.message, 'Outdoor wedding.');
  assert.ok(result.createdAt instanceof Date);
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0]!.status, 'Pending');
});

test('booking creation derives vendorId from service, not client input', async () => {
  const service = serviceRecord(VENDOR_ID);
  const vendor = userRecord(VENDOR_ID);
  const { database, bookings } = createMemoryDatabase({
    services: [service],
    bookings: [],
    users: [vendor],
  });

  const result = await createBooking(database, CUSTOMER_ID, {
    ...validInput,
    serviceId: service._id.toHexString(),
  });

  assert.equal(result.vendorId, VENDOR_ID);
  assert.equal(bookings[0]!.vendorId, VENDOR_ID);
});

test('booking creation populates service snapshot', async () => {
  const service = serviceRecord(VENDOR_ID);
  const vendor = userRecord(VENDOR_ID);
  const { database } = createMemoryDatabase({
    services: [service],
    bookings: [],
    users: [vendor],
  });

  const result = await createBooking(database, CUSTOMER_ID, {
    ...validInput,
    serviceId: service._id.toHexString(),
  });

  assert.ok(result.serviceSnapshot);
  assert.equal(result.serviceSnapshot!.serviceName, 'Wedding Photography');
  assert.equal(result.serviceSnapshot!.category, 'Photography & Videography');
  assert.equal(result.serviceSnapshot!.image, 'https://i.ibb.co/abc123/photo.jpg');
  assert.equal(result.serviceSnapshot!.price, 1200);
  assert.equal(result.serviceSnapshot!.vendor.name, 'John Vendor');
  assert.equal(result.serviceSnapshot!.vendor.businessName, 'Johns Weddings');
});

test('booking creation excludes private vendor information', async () => {
  const service = serviceRecord(VENDOR_ID);
  const vendor = userRecord(VENDOR_ID, {
    email: 'john@example.com',
    password: 'secret',
    subscriptionPlan: 'premium',
  });
  const { database } = createMemoryDatabase({
    services: [service],
    bookings: [],
    users: [vendor],
  });

  const result = await createBooking(database, CUSTOMER_ID, {
    ...validInput,
    serviceId: service._id.toHexString(),
  });

  assert.equal((result.serviceSnapshot as any)?.vendor.email, undefined);
  assert.equal((result.serviceSnapshot as any)?.vendor.password, undefined);
  assert.equal((result.serviceSnapshot as any)?.vendor.subscriptionPlan, undefined);
});

test('rejects booking a non-existent service', async () => {
  const { database } = createMemoryDatabase({ services: [], bookings: [], users: [] });
  await assert.rejects(
    () => createBooking(database, CUSTOMER_ID, { ...validInput, serviceId: new ObjectId().toHexString() }),
    { statusCode: 404, code: 'SERVICE_NOT_FOUND' },
  );
});

test('rejects booking a Pending service', async () => {
  const service = serviceRecord(VENDOR_ID, { status: 'Pending' });
  const { database } = createMemoryDatabase({ services: [service], bookings: [], users: [] });
  await assert.rejects(
    () => createBooking(database, CUSTOMER_ID, { ...validInput, serviceId: service._id.toHexString() }),
    { statusCode: 404, code: 'SERVICE_NOT_FOUND' },
  );
});

test('rejects booking a Rejected service', async () => {
  const service = serviceRecord(VENDOR_ID, { status: 'Rejected' });
  const { database } = createMemoryDatabase({ services: [service], bookings: [], users: [] });
  await assert.rejects(
    () => createBooking(database, CUSTOMER_ID, { ...validInput, serviceId: service._id.toHexString() }),
    { statusCode: 404, code: 'SERVICE_NOT_FOUND' },
  );
});

test('rejects booking an inactive service', async () => {
  const service = serviceRecord(VENDOR_ID, { availability: false });
  const { database } = createMemoryDatabase({ services: [service], bookings: [], users: [] });
  await assert.rejects(
    () => createBooking(database, CUSTOMER_ID, { ...validInput, serviceId: service._id.toHexString() }),
    { statusCode: 404, code: 'SERVICE_NOT_FOUND' },
  );
});

test('rejects self-booking when customer owns the service', async () => {
  const service = serviceRecord(CUSTOMER_ID);
  const vendor = userRecord(CUSTOMER_ID);
  const { database } = createMemoryDatabase({
    services: [service],
    bookings: [],
    users: [vendor],
  });
  await assert.rejects(
    () => createBooking(database, CUSTOMER_ID, { ...validInput, serviceId: service._id.toHexString() }),
    { statusCode: 409, code: 'OWN_SERVICE_BOOKING' },
  );
});

test('rejects duplicate Pending booking for same service and date', async () => {
  const service = serviceRecord(VENDOR_ID);
  const existingBooking = {
    _id: new ObjectId(),
    serviceId: service._id.toHexString(),
    vendorId: VENDOR_ID,
    customerId: 'other-customer',
    eventDate: '2027-06-15',
    eventLocation: 'Dhaka',
    status: 'Pending',
    createdAt: new Date(),
  };
  const { database, bookings } = createMemoryDatabase({
    services: [service],
    bookings: [existingBooking],
    users: [userRecord(VENDOR_ID)],
  });
  await assert.rejects(
    () => createBooking(database, CUSTOMER_ID, { ...validInput, serviceId: service._id.toHexString() }),
    { statusCode: 409, code: 'DUPLICATE_BOOKING' },
  );
  assert.equal(bookings.length, 1);
});

test('rejects duplicate Accepted booking for same service and date', async () => {
  const service = serviceRecord(VENDOR_ID);
  const existingBooking = {
    _id: new ObjectId(),
    serviceId: service._id.toHexString(),
    vendorId: VENDOR_ID,
    customerId: 'other-customer',
    eventDate: '2027-06-15',
    eventLocation: 'Dhaka',
    status: 'Accepted',
    createdAt: new Date(),
  };
  const { database, bookings } = createMemoryDatabase({
    services: [service],
    bookings: [existingBooking],
    users: [userRecord(VENDOR_ID)],
  });
  await assert.rejects(
    () => createBooking(database, CUSTOMER_ID, { ...validInput, serviceId: service._id.toHexString() }),
    { statusCode: 409, code: 'DUPLICATE_BOOKING' },
  );
  assert.equal(bookings.length, 1);
});

test('does not block new booking when existing Rejected booking exists', async () => {
  const service = serviceRecord(VENDOR_ID);
  const vendor = userRecord(VENDOR_ID);
  const existingBooking = {
    _id: new ObjectId(),
    serviceId: service._id.toHexString(),
    vendorId: VENDOR_ID,
    customerId: 'other-customer',
    eventDate: '2027-06-15',
    eventLocation: 'Dhaka',
    status: 'Rejected',
    createdAt: new Date(),
  };
  const { database, bookings } = createMemoryDatabase({
    services: [service],
    bookings: [existingBooking],
    users: [vendor],
  });

  const result = await createBooking(database, CUSTOMER_ID, {
    ...validInput,
    serviceId: service._id.toHexString(),
  });

  assert.equal(result.status, 'Pending');
  assert.equal(bookings.length, 2);
});

test('does not block new booking when existing Cancelled booking exists', async () => {
  const service = serviceRecord(VENDOR_ID);
  const vendor = userRecord(VENDOR_ID);
  const existingBooking = {
    _id: new ObjectId(),
    serviceId: service._id.toHexString(),
    vendorId: VENDOR_ID,
    customerId: 'other-customer',
    eventDate: '2027-06-15',
    eventLocation: 'Dhaka',
    status: 'Cancelled',
    createdAt: new Date(),
  };
  const { database, bookings } = createMemoryDatabase({
    services: [service],
    bookings: [existingBooking],
    users: [vendor],
  });

  const result = await createBooking(database, CUSTOMER_ID, {
    ...validInput,
    serviceId: service._id.toHexString(),
  });

  assert.equal(result.status, 'Pending');
  assert.equal(bookings.length, 2);
});

test('rejects invalid service ID format', async () => {
  const { database } = createMemoryDatabase({ services: [], bookings: [], users: [] });
  await assert.rejects(
    () => createBooking(database, CUSTOMER_ID, { ...validInput, serviceId: 'not-an-object-id' }),
    { statusCode: 400 },
  );
});

test('translates duplicate-key error 11000 to DUPLICATE_BOOKING', async () => {
  const service = serviceRecord(VENDOR_ID);
  const vendor = userRecord(VENDOR_ID);
  const { database } = createMemoryDatabase({
    services: [service],
    bookings: [],
    users: [vendor],
  });

  const originalCollection = database.collection.bind(database);
  (database as any).collection = (name: string) => {
    if (name === 'bookings') {
      return {
        findOne: async () => null,
        insertOne: async () => {
          const error: any = new Error('E11000 duplicate key');
          error.code = 11000;
          throw error;
        },
      };
    }
    return originalCollection(name);
  };

  await assert.rejects(
    () => createBooking(database, CUSTOMER_ID, { ...validInput, serviceId: service._id.toHexString() }),
    { statusCode: 409, code: 'DUPLICATE_BOOKING' },
  );
});

test('does not treat unrelated database errors as duplicate bookings', async () => {
  const service = serviceRecord(VENDOR_ID);
  const vendor = userRecord(VENDOR_ID);
  const { database } = createMemoryDatabase({
    services: [service],
    bookings: [],
    users: [vendor],
  });

  const originalCollection = database.collection.bind(database);
  (database as any).collection = (name: string) => {
    if (name === 'bookings') {
      return {
        findOne: async () => null,
        insertOne: async () => {
          const error: any = new Error('Unexpected database failure');
          error.code = 500;
          throw error;
        },
      };
    }
    return originalCollection(name);
  };

  await assert.rejects(
    () => createBooking(database, CUSTOMER_ID, { ...validInput, serviceId: service._id.toHexString() }),
    { message: 'Unexpected database failure' },
  );
});

test('does not insert booking when validation fails', async () => {
  const { database, bookings } = createMemoryDatabase({ services: [], bookings: [], users: [] });
  await assert.rejects(
    () => createBooking(database, CUSTOMER_ID, { ...validInput, serviceId: 'invalid' }),
    { statusCode: 400 },
  );
  assert.equal(bookings.length, 0);
});

test('does not insert booking when service is ineligible', async () => {
  const service = serviceRecord(VENDOR_ID, { status: 'Pending' });
  const { database, bookings } = createMemoryDatabase({
    services: [service],
    bookings: [],
    users: [],
  });
  await assert.rejects(
    () => createBooking(database, CUSTOMER_ID, { ...validInput, serviceId: service._id.toHexString() }),
    { statusCode: 404 },
  );
  assert.equal(bookings.length, 0);
});

test('rejects when vendor information cannot be resolved', async () => {
  const service = serviceRecord(VENDOR_ID);
  const { database } = createMemoryDatabase({
    services: [service],
    bookings: [],
    users: [],
  });
  await assert.rejects(
    () => createBooking(database, CUSTOMER_ID, { ...validInput, serviceId: service._id.toHexString() }),
    { statusCode: 404, code: 'VENDOR_NOT_FOUND' },
  );
});

const OTHER_CUSTOMER_ID = '6b01311fbff14dc2fcc15479';

function customerBookingRecord(
  ownerId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    _id: new ObjectId(),
    vendorId: VENDOR_ID,
    customerId: ownerId,
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

test('customer booking list query schema accepts valid input', () => {
  assert.equal(
    customerBookingQuerySchema.safeParse({ status: 'Pending', page: '1', limit: '10' }).success,
    true,
  );
  assert.equal(
    customerBookingQuerySchema.safeParse({}).success,
    true,
  );
});

test('customer booking list query schema defaults page and limit', () => {
  const result = customerBookingQuerySchema.safeParse({});
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.page, 1);
    assert.equal(result.data.limit, 10);
  }
});

test('customer booking list query schema rejects invalid status', () => {
  assert.equal(
    customerBookingQuerySchema.safeParse({ status: 'Invalid' }).success,
    false,
  );
});

test('get customer bookings returns only bookings for the authenticated customer', async () => {
  const ownBooking = customerBookingRecord(CUSTOMER_ID);
  const otherBooking = customerBookingRecord(OTHER_CUSTOMER_ID, {
    _id: new ObjectId(),
  });
  const { database } = createMemoryDatabase({
    bookings: [ownBooking, otherBooking],
    services: [],
    users: [],
  });

  const result = await getCustomerBookings(database, {
    customerId: CUSTOMER_ID,
    page: 1,
    limit: 10,
  });

  assert.equal(result.bookings.length, 1);
  assert.equal(result.bookings[0]!.customerId, CUSTOMER_ID);
  assert.equal(result.pagination.total, 1);
});

test('get customer bookings does not expose another customer bookings', async () => {
  const otherBooking = customerBookingRecord(OTHER_CUSTOMER_ID);
  const { database } = createMemoryDatabase({
    bookings: [otherBooking],
    services: [],
    users: [],
  });

  const result = await getCustomerBookings(database, {
    customerId: CUSTOMER_ID,
    page: 1,
    limit: 10,
  });

  assert.equal(result.bookings.length, 0);
  assert.equal(result.pagination.total, 0);
});

test('get customer bookings filters by status', async () => {
  const pendingBooking = customerBookingRecord(CUSTOMER_ID, { status: 'Pending' });
  const acceptedBooking = customerBookingRecord(CUSTOMER_ID, {
    _id: new ObjectId(),
    status: 'Accepted',
  });
  const { database } = createMemoryDatabase({
    bookings: [pendingBooking, acceptedBooking],
    services: [],
    users: [],
  });

  const result = await getCustomerBookings(database, {
    customerId: CUSTOMER_ID,
    status: 'Pending',
    page: 1,
    limit: 10,
  });

  assert.equal(result.bookings.length, 1);
  assert.equal(result.bookings[0]!.status, 'Pending');
});

test('get customer bookings supports pagination', async () => {
  const bookings = [
    customerBookingRecord(CUSTOMER_ID),
    customerBookingRecord(CUSTOMER_ID, { _id: new ObjectId() }),
    customerBookingRecord(CUSTOMER_ID, { _id: new ObjectId() }),
  ];
  const { database } = createMemoryDatabase({
    bookings,
    services: [],
    users: [],
  });

  const result = await getCustomerBookings(database, {
    customerId: CUSTOMER_ID,
    page: 1,
    limit: 2,
  });

  assert.equal(result.bookings.length, 2);
  assert.equal(result.pagination.page, 1);
  assert.equal(result.pagination.limit, 2);
  assert.equal(result.pagination.total, 3);
  assert.equal(result.pagination.totalPages, 2);
});

test('get customer bookings sorts newest first', async () => {
  const older = customerBookingRecord(CUSTOMER_ID, {
    _id: new ObjectId(),
    createdAt: new Date('2027-01-01'),
  });
  const newer = customerBookingRecord(CUSTOMER_ID, {
    _id: new ObjectId(),
    createdAt: new Date('2027-06-01'),
  });
  const { database } = createMemoryDatabase({
    bookings: [older, newer],
    services: [],
    users: [],
  });

  const result = await getCustomerBookings(database, {
    customerId: CUSTOMER_ID,
    page: 1,
    limit: 10,
  });

  assert.equal(result.bookings.length, 2);
  assert.equal(result.bookings[0]!.createdAt.getTime(), newer.createdAt.getTime());
});

test('get customer bookings returns empty result when no bookings exist', async () => {
  const { database } = createMemoryDatabase({ services: [], bookings: [], users: [] });

  const result = await getCustomerBookings(database, {
    customerId: CUSTOMER_ID,
    page: 1,
    limit: 10,
  });

  assert.equal(result.bookings.length, 0);
  assert.equal(result.pagination.total, 0);
  assert.equal(result.pagination.totalPages, 0);
});

test('cancel booking transitions Pending to Cancelled', async () => {
  const booking = customerBookingRecord(CUSTOMER_ID);
  const { database, bookings } = createMemoryDatabase({
    bookings: [booking],
    services: [],
    users: [],
  });

  const result = await cancelBooking(database, booking._id.toHexString(), CUSTOMER_ID);

  assert.equal(result.status, 'Cancelled');
  assert.equal(result.id, booking._id.toHexString());
  assert.equal(bookings[0]!.status, 'Cancelled');
});

test('cancel booking cancels only own booking', async () => {
  const booking = customerBookingRecord(OTHER_CUSTOMER_ID);
  const { database } = createMemoryDatabase({
    bookings: [booking],
    services: [],
    users: [],
  });

  await assert.rejects(
    () => cancelBooking(database, booking._id.toHexString(), CUSTOMER_ID),
    { statusCode: 404, code: 'BOOKING_NOT_FOUND' },
  );
});

test('cancel nonexistent booking returns 404', async () => {
  const { database } = createMemoryDatabase({ services: [], bookings: [], users: [] });

  await assert.rejects(
    () => cancelBooking(database, new ObjectId().toHexString(), CUSTOMER_ID),
    { statusCode: 404, code: 'BOOKING_NOT_FOUND' },
  );
});

test('cancel already Accepted booking returns 409', async () => {
  const booking = customerBookingRecord(CUSTOMER_ID, { status: 'Accepted' });
  const { database } = createMemoryDatabase({
    bookings: [booking],
    services: [],
    users: [],
  });

  await assert.rejects(
    () => cancelBooking(database, booking._id.toHexString(), CUSTOMER_ID),
    { statusCode: 409, code: 'BOOKING_ALREADY_PROCESSED' },
  );
});

test('cancel already Rejected booking returns 409', async () => {
  const booking = customerBookingRecord(CUSTOMER_ID, { status: 'Rejected' });
  const { database } = createMemoryDatabase({
    bookings: [booking],
    services: [],
    users: [],
  });

  await assert.rejects(
    () => cancelBooking(database, booking._id.toHexString(), CUSTOMER_ID),
    { statusCode: 409, code: 'BOOKING_ALREADY_PROCESSED' },
  );
});

test('cancel already Cancelled booking returns 409', async () => {
  const booking = customerBookingRecord(CUSTOMER_ID, { status: 'Cancelled' });
  const { database } = createMemoryDatabase({
    bookings: [booking],
    services: [],
    users: [],
  });

  await assert.rejects(
    () => cancelBooking(database, booking._id.toHexString(), CUSTOMER_ID),
    { statusCode: 409, code: 'BOOKING_ALREADY_PROCESSED' },
  );
});

test('cancel invalid booking ID returns 400', async () => {
  const { database } = createMemoryDatabase({ services: [], bookings: [], users: [] });

  await assert.rejects(
    () => cancelBooking(database, 'not-an-object-id', CUSTOMER_ID),
    { statusCode: 400, code: 'INVALID_OBJECT_ID' },
  );
});
