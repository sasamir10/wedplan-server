import {
  ObjectId,
  type Collection,
  type Db,
  type Document,
} from 'mongodb';
import {
  createBookingSchema,
  type BookingDocument,
  type BookingResponse,
  type BookingStatus,
  type ServiceSnapshot,
} from '../models/booking.js';
import { AppError } from '../utils/app-error.js';
import { parseObjectId, toBetterAuthUserObjectId } from '../utils/object-id.js';

interface CustomerPublicDocument {
  _id: ObjectId;
  name?: string | null;
  image?: string | null;
}

interface VendorPublicDocument {
  _id: ObjectId;
  name?: string | null;
  businessName?: string | null;
}

interface ServiceRecord extends Document {
  _id: ObjectId;
  vendorId: string;
  serviceName: string;
  category: string;
  price: number;
  images: string[];
  status: string;
  availability: boolean;
}

interface BookingInput {
  serviceId: string;
  eventDate: string;
  eventLocation: string;
  message?: string;
}

interface VendorBookingListInput {
  vendorId: string;
  status?: BookingStatus;
  page: number;
  limit: number;
}

function bookingsCollection(database: Db): Collection<BookingDocument> {
  return database.collection<BookingDocument>('bookings');
}

function servicesCollection(database: Db): Collection<ServiceRecord> {
  return database.collection<ServiceRecord>('services');
}

function usersCollection(database: Db): Collection<VendorPublicDocument> {
  return database.collection<VendorPublicDocument>('user');
}

function toBookingResponse(booking: BookingDocument): BookingResponse {
  return {
    id: booking._id.toHexString(),
    serviceId: booking.serviceId,
    vendorId: booking.vendorId,
    customerId: booking.customerId,
    eventDate: booking.eventDate,
    eventLocation: booking.eventLocation,
    message: booking.message,
    status: booking.status,
    createdAt: booking.createdAt,
    serviceSnapshot: booking.serviceSnapshot,
  };
}

async function fetchVendorPublicInfo(
  database: Db,
  vendorIdHex: string,
): Promise<{ name: string | null; businessName: string | null } | null> {
  const vendorObjectId = toBetterAuthUserObjectId(vendorIdHex);
  if (!vendorObjectId) {
    return null;
  }
  const vendorDoc = await usersCollection(database).findOne(
    { _id: vendorObjectId },
    { projection: { name: 1, businessName: 1, _id: 0 } },
  );
  if (!vendorDoc) {
    return null;
  }
  return {
    name: vendorDoc.name ?? null,
    businessName: vendorDoc.businessName ?? null,
  };
}

export async function createBooking(
  database: Db,
  customerId: string,
  input: BookingInput,
): Promise<BookingResponse> {
  const parsed = createBookingSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError('Invalid booking request. Check the submitted fields.', 400);
  }

  const { serviceId, eventDate, eventLocation, message } = parsed.data;

  const serviceObjectId = parseObjectId(serviceId, 'service');

  const service = await servicesCollection(database).findOne({ _id: serviceObjectId });
  if (!service || service.status !== 'Approved' || !service.availability) {
    throw new AppError('Service not found or not available for booking.', 404, true, 'SERVICE_NOT_FOUND');
  }

  if (service.vendorId === customerId) {
    throw new AppError('You cannot book your own service.', 409, true, 'OWN_SERVICE_BOOKING');
  }

  const existing = await bookingsCollection(database).findOne({
    serviceId,
    eventDate,
    status: { $in: ['Pending', 'Accepted'] },
  });
  if (existing) {
    throw new AppError('An active booking already exists for this service and date.', 409, true, 'DUPLICATE_BOOKING');
  }

  const vendor = await fetchVendorPublicInfo(database, service.vendorId);
  if (!vendor) {
    throw new AppError('Vendor information could not be resolved.', 404, true, 'VENDOR_NOT_FOUND');
  }

  const serviceSnapshot: ServiceSnapshot = {
    serviceName: service.serviceName,
    category: service.category,
    image: service.images?.[0] ?? '',
    price: service.price,
    vendor: {
      name: vendor.name ?? null,
      businessName: vendor.businessName ?? null,
    },
  };

  const now = new Date();
  const booking: BookingDocument = {
    _id: new ObjectId(),
    serviceId,
    vendorId: service.vendorId,
    customerId,
    eventDate,
    eventLocation,
    ...(message !== undefined ? { message } : {}),
    status: 'Pending',
    createdAt: now,
    serviceSnapshot,
  };

  try {
    await bookingsCollection(database).insertOne(booking);
  } catch (error) {
    const mongoError = error as { code?: number };
    if (mongoError?.code === 11000) {
      throw new AppError('An active booking already exists for this service and date.', 409, true, 'DUPLICATE_BOOKING');
    }
    throw error;
  }

  return toBookingResponse(booking);
}

async function fetchCustomerDisplay(
  database: Db,
  customerIdHex: string,
): Promise<{ name: string | null; image: string | null } | null> {
  const customerObjectId = toBetterAuthUserObjectId(customerIdHex);
  if (!customerObjectId) {
    return null;
  }
  const customerDoc = await database
    .collection<CustomerPublicDocument>('user')
    .findOne(
      { _id: customerObjectId },
      { projection: { name: 1, image: 1, _id: 0 } },
    );
  if (!customerDoc) {
    return null;
  }
  return {
    name: customerDoc.name ?? null,
    image: customerDoc.image ?? null,
  };
}

interface VendorBookingEntry extends BookingResponse {
  customer: { name: string | null; image: string | null } | null;
}

export async function getVendorBookings(
  database: Db,
  input: VendorBookingListInput,
): Promise<{ bookings: VendorBookingEntry[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
  const { vendorId, status, page, limit } = input;

  const filter: Record<string, unknown> = { vendorId };
  if (status) filter.status = status;

  const bookingsCollectionRef = bookingsCollection(database);
  const [total, bookings] = await Promise.all([
    bookingsCollectionRef.countDocuments(filter),
    bookingsCollectionRef
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
  ]);

  const customerIds = [...new Set(bookings.map((booking) => booking.customerId))];
  const customerObjectIds = customerIds
    .map((customerId) => toBetterAuthUserObjectId(customerId))
    .filter((customerId): customerId is ObjectId => customerId !== null);

  const customers: CustomerPublicDocument[] = customerObjectIds.length
    ? await database
        .collection<CustomerPublicDocument>('user')
        .find({ _id: { $in: customerObjectIds } })
        .project<CustomerPublicDocument>({ name: 1, image: 1 })
        .toArray()
    : [];
  const customersById = new Map(
    customers.map((customer) => [
      customer._id.toHexString(),
      {
        name: customer.name ?? null,
        image: customer.image ?? null,
      },
    ]),
  );

  return {
    bookings: bookings.map((booking) => ({
      ...toBookingResponse(booking),
      customer: customersById.get(booking.customerId) ?? null,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

async function findBookingByIdAndVendor(
  database: Db,
  bookingId: ObjectId,
  vendorId: string,
): Promise<BookingDocument | null> {
  return bookingsCollection(database).findOne({ _id: bookingId, vendorId });
}

export async function acceptBooking(
  database: Db,
  bookingId: string,
  vendorId: string,
): Promise<BookingResponse> {
  const id = parseObjectId(bookingId, 'booking');

  const updated = await bookingsCollection(database).findOneAndUpdate(
    { _id: id, vendorId, status: 'Pending' },
    { $set: { status: 'Accepted' } },
    { returnDocument: 'after' },
  );

  if (updated) {
    return toBookingResponse(updated as unknown as BookingDocument);
  }

  const existing = await findBookingByIdAndVendor(database, id, vendorId);
  if (!existing) {
    throw new AppError('Booking not found.', 404, true, 'BOOKING_NOT_FOUND');
  }
  throw new AppError('Only pending bookings can be accepted.', 409, true, 'BOOKING_ALREADY_PROCESSED');
}

export async function rejectBooking(
  database: Db,
  bookingId: string,
  vendorId: string,
): Promise<BookingResponse> {
  const id = parseObjectId(bookingId, 'booking');

  const updated = await bookingsCollection(database).findOneAndUpdate(
    { _id: id, vendorId, status: 'Pending' },
    { $set: { status: 'Rejected' } },
    { returnDocument: 'after' },
  );

  if (updated) {
    return toBookingResponse(updated as unknown as BookingDocument);
  }

  const existing = await findBookingByIdAndVendor(database, id, vendorId);
  if (!existing) {
    throw new AppError('Booking not found.', 404, true, 'BOOKING_NOT_FOUND');
  }
  throw new AppError('Only pending bookings can be rejected.', 409, true, 'BOOKING_ALREADY_PROCESSED');
}

interface CustomerBookingListInput {
  customerId: string;
  status?: BookingStatus;
  page: number;
  limit: number;
}

export async function getCustomerBookings(
  database: Db,
  input: CustomerBookingListInput,
): Promise<{ bookings: BookingResponse[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
  const { customerId, status, page, limit } = input;

  const filter: Record<string, unknown> = { customerId };
  if (status) filter.status = status;

  const bookingsCollectionRef = bookingsCollection(database);
  const [total, bookings] = await Promise.all([
    bookingsCollectionRef.countDocuments(filter),
    bookingsCollectionRef
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
  ]);

  return {
    bookings: bookings.map((booking) => toBookingResponse(booking)),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

async function findBookingByIdAndCustomer(
  database: Db,
  bookingId: ObjectId,
  customerId: string,
): Promise<BookingDocument | null> {
  return bookingsCollection(database).findOne({ _id: bookingId, customerId });
}

export async function cancelBooking(
  database: Db,
  bookingId: string,
  customerId: string,
): Promise<BookingResponse> {
  const id = parseObjectId(bookingId, 'booking');

  const updated = await bookingsCollection(database).findOneAndUpdate(
    { _id: id, customerId, status: 'Pending' },
    { $set: { status: 'Cancelled' } },
    { returnDocument: 'after' },
  );

  if (updated) {
    return toBookingResponse(updated as unknown as BookingDocument);
  }

  const existing = await findBookingByIdAndCustomer(database, id, customerId);
  if (!existing) {
    throw new AppError('Booking not found.', 404, true, 'BOOKING_NOT_FOUND');
  }
  throw new AppError('Only pending bookings can be cancelled.', 409, true, 'BOOKING_ALREADY_PROCESSED');
}
