import { z } from 'zod';
import { serviceCategories, serviceStatuses } from './service.js';

const positiveQueryInteger = (maximum: number) =>
  z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(maximum));

export const adminServiceQuerySchema = z
  .strictObject({
    search: z.string().trim().max(120).optional(),
    status: z.enum(serviceStatuses).optional(),
    category: z.enum(serviceCategories).optional(),
    availability: z.enum(['true', 'false']).optional(),
    page: positiveQueryInteger(100_000).optional(),
    limit: positiveQueryInteger(100).optional(),
  })
  .transform(({ availability, page, limit, ...filters }) => ({
    ...filters,
    availability: availability === undefined ? undefined : availability === 'true',
    page: page ?? 1,
    limit: limit ?? 20,
  }));

export const adminServiceStatusSchema = z.strictObject({
  status: z.enum(serviceStatuses),
});

export const emptyAdminServiceBodySchema = z.strictObject({});

export type AdminServiceQuery = z.infer<typeof adminServiceQuerySchema>;
export type AdminServiceStatusInput = z.infer<typeof adminServiceStatusSchema>;
