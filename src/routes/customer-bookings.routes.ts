import { Router, type Request } from 'express';
import type { Db } from 'mongodb';
import { createBookingSchema } from '../models/booking.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRoles } from '../middleware/authorize.js';
import { createBooking } from '../services/booking.service.js';
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

export function createCustomerBookingsRouter(database: Db) {
  const router = Router();

  router.use(authenticate, authorizeRoles('customer'));

  router.post('/bookings', async (request, response) => {
    const input = parseBody(createBookingSchema, request.body);
    const booking = await createBooking(database, requireCustomerId(request), input);
    response.status(201).json({ success: true, booking });
  });

  return router;
}
