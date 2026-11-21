import { z } from 'zod';

export const serviceCategories = [
  'Photography & Videography',
  'Wedding Venues',
  'Decoration & Florist',
  'Catering Services',
  'Makeup & Styling',
  'Wedding Fashion',
] as const;

export const serviceStatuses = ['Pending', 'Approved', 'Rejected'] as const;

const hostedImageUrlSchema = z.url({ protocol: /^https?$/ });

export const createServiceSchema = z.strictObject({
  serviceName: z.string().trim().min(1).max(120),
  category: z.enum(serviceCategories),
  description: z.string().trim().min(20).max(3000),
  price: z.number().finite().positive(),
  location: z.string().trim().min(1).max(200),
  images: z.array(hostedImageUrlSchema).min(1).max(10),
});

export const updateServiceSchema = z
  .strictObject({
    serviceName: z.string().trim().min(1).max(120).optional(),
    category: z.enum(serviceCategories).optional(),
    description: z.string().trim().min(20).max(3000).optional(),
    price: z.number().finite().positive().optional(),
    location: z.string().trim().min(1).max(200).optional(),
    images: z.array(hostedImageUrlSchema).min(1).max(10).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one service field to update.',
  });

export const updateAvailabilitySchema = z.strictObject({
  availability: z.boolean(),
});

export type ServiceCategory = (typeof serviceCategories)[number];
export type ServiceStatus = (typeof serviceStatuses)[number];
export type CreateServiceInput = z.infer<typeof createServiceSchema>;
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;

