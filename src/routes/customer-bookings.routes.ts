import { Router, type Request } from 'express';
import type { Db } from 'mongodb';
import {
  createBookingSchema,
  customerBookingQuerySchema,
} from '../models/booking.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRoles } from '../middleware/authorize.js';
import {
  cancelBooking,
  createBooking,
  getCustomerBookings,
} from '../services/booking.service.js';
import { AppError } from '../utils/app-error.js';

function requireCustomerId(request: Request): string {
  const customerId = request.authenticatedUser?.id;
  if (!customerId) {
    throw new AppError('Authentication required.', 401);
  }
  return customerId;
}

function parseBody<T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  body: unknown,
): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError('Invalid booking request. Check the submitted fields.', 400);
  }
  return result.data;
}

function parseQuery(requestQuery: unknown) {
  const result = customerBookingQuerySchema.safeParse(requestQuery);
  if (!result.success) {
    throw new AppError('Invalid booking filters or pagination values.', 400);
  }
  return result.data;
}

const emptyBookingBodySchema = {
  safeParse: () => ({ success: true, data: {} }),
};

export function createCustomerBookingsRouter(database: Db) {
  const router = Router();

  router.use(authenticate, authorizeRoles('customer'));

  router.get('/bookings', async (request, response) => {
    const query = parseQuery(request.query);
    const result = await getCustomerBookings(database, {
      customerId: requireCustomerId(request),
      ...query,
    });
    response.status(200).json({ success: true, ...result });
  });

  router.post('/bookings', async (request, response) => {
    const input = parseBody(createBookingSchema, request.body);
    const booking = await createBooking(database, requireCustomerId(request), input);
    response.status(201).json({ success: true, booking });
  });

  router.patch('/bookings/:bookingId/cancel', async (request, response) => {
    parseBody(emptyBookingBodySchema, request.body);
    const booking = await cancelBooking(
      database,
      request.params.bookingId,
      requireCustomerId(request),
    );
    response.status(200).json({ success: true, booking });
  });

  return router;
}
