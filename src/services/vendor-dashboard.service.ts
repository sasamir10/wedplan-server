import {
  ObjectId,
  type Collection,
  type Db,
} from 'mongodb';
import { AppError } from '../utils/app-error.js';
import { toBetterAuthUserObjectId } from '../utils/object-id.js';

interface VendorStats {
  totalServices: number;
  activeServices: number;
  pendingBookingRequests: number;
  acceptedBookings: number;
  subscriptionPlan: string;
}

interface UserDocument {
  _id: ObjectId;
  subscriptionPlan?: string | null;
}

function servicesCollection(database: Db): Collection {
  return database.collection('services');
}

function bookingsCollection(database: Db): Collection {
  return database.collection('bookings');
}

function usersCollection(database: Db): Collection<UserDocument> {
  return database.collection<UserDocument>('user');
}

export async function getVendorStats(
  database: Db,
  vendorId: string,
): Promise<VendorStats> {
  const vendorObjectId = toBetterAuthUserObjectId(vendorId);

  if (!vendorObjectId) {
    throw new AppError(
      'Vendor subscription could not be verified.',
      403,
      true,
      'VENDOR_NOT_FOUND',
    );
  }

  const vendor = await usersCollection(database).findOne(
    { _id: vendorObjectId },
    { projection: { subscriptionPlan: 1, _id: 0 } },
  );

  if (!vendor) {
    throw new AppError(
      'Vendor subscription could not be verified.',
      403,
      true,
      'VENDOR_NOT_FOUND',
    );
  }

  const subscriptionPlan =
    vendor.subscriptionPlan === 'free' ||
    vendor.subscriptionPlan === 'premium'
      ? vendor.subscriptionPlan
      : 'free';

  const [totalServices, activeServices, pendingBookingRequests, acceptedBookings] =
    await Promise.all([
      servicesCollection(database).countDocuments({ vendorId }),
      servicesCollection(database).countDocuments({
        vendorId,
        availability: true,
      }),
      bookingsCollection(database).countDocuments({
        vendorId,
        status: 'Pending',
      }),
      bookingsCollection(database).countDocuments({
        vendorId,
        status: 'Accepted',
      }),
    ]);

  return {
    totalServices,
    activeServices,
    pendingBookingRequests,
    acceptedBookings,
    subscriptionPlan,
  };
}
