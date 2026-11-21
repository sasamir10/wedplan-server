import { z } from 'zod';
import type { Collection, Db } from 'mongodb';
import { AppError } from '../utils/app-error.js';
import { toBetterAuthUserObjectId } from '../utils/object-id.js';

interface Profile {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  role: string;
  businessName: string | null;
  subscriptionPlan: string;
}

interface UpdateProfileInput {
  name?: string;
  image?: string | null;
}

const updateProfileSchema = z.strictObject({
  name: z.string().trim().min(1, 'Name is required.').max(100, 'Name must be 100 characters or fewer.').optional(),
  image: z
    .string()
    .url()
    .refine(
      (value) => {
        try {
          const url = new URL(value);
          return url.protocol === 'https:' && url.hostname === 'i.ibb.co';
        } catch {
          return false;
        }
      },
      'Profile image must be a valid hosted image URL.',
    )
    .optional(),
});

function usersCollection(database: Db): Collection {
  return database.collection('user');
}

function toProfileResponse(user: Record<string, unknown>, userId: string): Profile {
  return {
    id: userId,
    name: typeof user.name === 'string' ? user.name : null,
    email: typeof user.email === 'string' ? user.email : '',
    image: typeof user.image === 'string' ? user.image : null,
    role: typeof user.role === 'string' ? user.role : 'customer',
    businessName:
      typeof user.businessName === 'string' ? user.businessName : null,
    subscriptionPlan:
      typeof user.subscriptionPlan === 'string'
        ? user.subscriptionPlan
        : 'free',
  };
}

export async function getProfile(
  database: Db,
  userId: string,
): Promise<Profile> {
  const userObjectId = toBetterAuthUserObjectId(userId);

  if (!userObjectId) {
    throw new AppError(
      'User account could not be verified.',
      403,
      true,
      'USER_NOT_FOUND',
    );
  }

  const user = await usersCollection(database).findOne(
    { _id: userObjectId },
    {
      projection: {
        name: 1,
        email: 1,
        image: 1,
        role: 1,
        businessName: 1,
        subscriptionPlan: 1,
        _id: 0,
      },
    },
  );

  if (!user) {
    throw new AppError(
      'User account could not be verified.',
      403,
      true,
      'USER_NOT_FOUND',
    );
  }

  return toProfileResponse(user, userId);
}

export async function updateProfile(
  database: Db,
  userId: string,
  input: unknown,
): Promise<Profile> {
  const parsed = updateProfileSchema.safeParse(input);

  if (!parsed.success) {
    throw new AppError(
      'Invalid profile update. Check the submitted fields.',
      400,
    );
  }

  const { name, image } = parsed.data;
  const userObjectId = toBetterAuthUserObjectId(userId);

  if (!userObjectId) {
    throw new AppError(
      'User account could not be verified.',
      403,
      true,
      'USER_NOT_FOUND',
    );
  }

  const updateFields: Record<string, unknown> = {};

  if (name !== undefined) {
    updateFields.name = name;
  }

  if (image !== undefined) {
    updateFields.image = image;
  }

  if (Object.keys(updateFields).length === 0) {
    throw new AppError('No profile fields to update.', 400);
  }

  const result = await usersCollection(database).findOneAndUpdate(
    { _id: userObjectId },
    { $set: updateFields },
    {
      returnDocument: 'after',
      projection: {
        name: 1,
        email: 1,
        image: 1,
        role: 1,
        businessName: 1,
        subscriptionPlan: 1,
        _id: 0,
      },
    },
  );

  if (!result) {
    throw new AppError(
      'User account could not be verified.',
      403,
      true,
      'USER_NOT_FOUND',
    );
  }

  return toProfileResponse(result, userId);
}
