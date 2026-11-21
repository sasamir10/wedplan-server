import {
  type Collection,
  type Db,
} from 'mongodb';
import { AppError } from '../utils/app-error.js';
import { toBetterAuthUserObjectId } from '../utils/object-id.js';

interface CustomerStats {
  totalBookingRequests: number;
  pendingBookings: number;
  acceptedBookings: number;
  rejectedBookings: number;
}

function bookingsCollection(database: Db): Collection {
  return database.collection('bookings');
}

export async function getCustomerStats(
  database: Db,
  customerId: string,
): Promise<CustomerStats> {
  const customerObjectId = toBetterAuthUserObjectId(customerId);

  if (!customerObjectId) {
    throw new AppError(
      'Customer account could not be verified.',
      403,
      true,
      'CUSTOMER_NOT_FOUND',
    );
  }

  const [totalBookingRequests, pendingBookings, acceptedBookings, rejectedBookings] =
    await Promise.all([
      bookingsCollection(database).countDocuments({ customerId }),
      bookingsCollection(database).countDocuments({
        customerId,
        status: 'Pending',
      }),
      bookingsCollection(database).countDocuments({
        customerId,
        status: 'Accepted',
      }),
      bookingsCollection(database).countDocuments({
        customerId,
        status: 'Rejected',
      }),
    ]);

  return {
    totalBookingRequests,
    pendingBookings,
    acceptedBookings,
    rejectedBookings,
  };
}
