import { z } from 'zod';
import { serviceCategories } from './service.js';

export const publicServiceQuerySchema = z.strictObject({
  search: z.string().trim().max(120).optional(),
  category: z.enum(serviceCategories).optional(),
  location: z.string().trim().max(200).optional(),
  sort: z.enum(['default', 'price-asc', 'price-desc']).optional(),
}).transform(({ search, category, location, sort }) => ({
  ...(search ? { search } : {}),
  ...(category ? { category } : {}),
  ...(location ? { location } : {}),
  ...(sort ? { sort } : {}),
}));

export type PublicServiceQuery = z.infer<typeof publicServiceQuerySchema>;
