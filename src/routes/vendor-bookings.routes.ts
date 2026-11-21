import { Router, type Request } from 'express';
import type { Db } from 'mongodb';
import { vendorBookingQuerySchema } from '../models/booking.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRoles } from '../middleware/authorize.js';
import { enforceBlockStatus } from '../middleware/block-status.js';
import {
  acceptBooking,
  getVendorBookings,
  rejectBooking,
} from '../services/booking.service.js';
import { AppError } from '../utils/app-error.js';

function requireVendorId(request: Request): string {
  const vendorId = request.authenticatedUser?.id;
  if (!vendorId) {
    throw new AppError('Authentication required.', 401);
  }
  return vendorId;
}

function parseBody<T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  body: unknown,
): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new AppError('Invalid booking request.', 400);
  }
  return result.data;
}

function parseQuery(requestQuery: unknown) {
  const result = vendorBookingQuerySchema.safeParse(requestQuery);
  if (!result.success) {
    throw new AppError('Invalid booking filters or pagination values.', 400);
  }
  return result.data;
}

const emptyBookingBodySchema = {
  safeParse: () => ({ success: true, data: {} }),
};

export function createVendorBookingsRouter(database: Db) {
  const router = Router();

  router.use(authenticate, authorizeRoles('vendor'), enforceBlockStatus(database));

  router.get('/bookings', async (request, response) => {
    const query = parseQuery(request.query);
    const result = await getVendorBookings(database, {
      vendorId: requireVendorId(request),
      ...query,
    });
    response.status(200).json({ success: true, ...result });
  });

  router.patch('/bookings/:bookingId/accept', async (request, response) => {
    parseBody(emptyBookingBodySchema, request.body);
    const booking = await acceptBooking(
      database,
      request.params.bookingId,
      requireVendorId(request),
    );
    response.status(200).json({ success: true, booking });
  });

  router.patch('/bookings/:bookingId/reject', async (request, response) => {
    parseBody(emptyBookingBodySchema, request.body);
    const booking = await rejectBooking(
      database,
      request.params.bookingId,
      requireVendorId(request),
    );
    response.status(200).json({ success: true, booking });
  });

  return router;
}

