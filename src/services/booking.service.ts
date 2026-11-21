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
  type ServiceSnapshot,
} from '../models/booking.js';
import { AppError } from '../utils/app-error.js';
import { parseObjectId, toBetterAuthUserObjectId } from '../utils/object-id.js';

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
