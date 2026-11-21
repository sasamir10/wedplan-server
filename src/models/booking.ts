import { z } from 'zod';
import {
  ObjectId,
  type Document,
} from 'mongodb';

export const bookingStatuses = ['Pending', 'Accepted', 'Rejected', 'Cancelled'] as const;

export type BookingStatus = (typeof bookingStatuses)[number];

export const bookingStatusSchema = z.enum(bookingStatuses);

const OBJECT_ID_HEX_PATTERN = /^[a-f\d]{24}$/i;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

export const createBookingSchema = z.strictObject({
  serviceId: z
    .string()
    .regex(
      OBJECT_ID_HEX_PATTERN,
      'Service ID must be a valid 24-character hexadecimal ObjectId.',
    ),
  eventDate: z
    .string()
    .regex(DATE_PATTERN, 'Event date must be in YYYY-MM-DD format.')
    .refine(
      isValidCalendarDate,
      'Event date must be a valid calendar date.',
    ),
  eventLocation: z.string().trim().min(1, 'Event location is required.'),
  message: z.string().trim().optional(),
});

const positiveQueryInteger = (maximum: number) =>
  z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(maximum));

export const vendorBookingQuerySchema = z
  .strictObject({
    status: bookingStatusSchema.optional(),
    page: positiveQueryInteger(100_000).optional(),
    limit: positiveQueryInteger(50).optional(),
  })
  .transform(({ page, limit, ...filters }) => ({
    ...filters,
    page: page ?? 1,
    limit: limit ?? 10,
  }));

export type VendorBookingQuery = z.infer<typeof vendorBookingQuerySchema>;

/**
 * Optional technical extension (not a mandatory field from the original assignment).
 *
 * Preserves the minimum service information needed to display historical booking
 * records even if the original service record is subsequently deleted or
 * deactivated. Vendor display information never includes email, password,
 * private account data, or subscription secrets.
 */
export interface ServiceSnapshot {
  serviceName: string;
  category: string;
  image: string;
  price: number;
  vendor: {
    name: string | null;
    businessName: string | null;
  };
}

export interface BookingDocument extends Document {
  _id: ObjectId;
  serviceId: string;
  vendorId: string;
  customerId: string;
  eventDate: string;
  eventLocation: string;
  message?: string;
  status: BookingStatus;
  createdAt: Date;
  serviceSnapshot?: ServiceSnapshot;
}

export interface BookingResponse {
  id: string;
  serviceId: string;
  vendorId: string;
  customerId: string;
  eventDate: string;
  eventLocation: string;
  message?: string;
  status: BookingStatus;
  createdAt: Date;
  serviceSnapshot?: ServiceSnapshot;
}
