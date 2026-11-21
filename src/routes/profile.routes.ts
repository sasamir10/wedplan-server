import { Router, type Request } from 'express';
import type { Db } from 'mongodb';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRoles } from '../middleware/authorize.js';
import { enforceBlockStatus } from '../middleware/block-status.js';
import { receiveImageUpload } from '../middleware/image-upload.js';
import { env } from '../config/env.js';
import { getProfile, updateProfile } from '../services/profile.service.js';
import { uploadImageToImgBB } from '../services/image-upload.service.js';
import { AppError } from '../utils/app-error.js';

function requireUserId(request: Request): string {
  const userId = request.authenticatedUser?.id;

  if (!userId) {
    throw new AppError('Authentication required.', 401);
  }

  return userId;
}

export function createProfileRouter(database: Db) {
  const router = Router();

  router.use(authenticate, authorizeRoles('customer', 'vendor'), enforceBlockStatus(database));

  router.get('/', async (request, response) => {
    const profile = await getProfile(database, requireUserId(request));
    response.status(200).json({ success: true, profile });
  });

  router.patch('/', async (request, response) => {
    const profile = await updateProfile(
      database,
      requireUserId(request),
      request.body,
    );
    response.status(200).json({ success: true, profile });
  });

  router.post(
    '/upload-image',
    (_request, _response, next) => {
      if (!env.IMGBB_API_KEY) {
        return next(new AppError('Image uploads are not configured.', 503));
      }

      return next();
    },
    receiveImageUpload,
    async (request, response) => {
      const image = request.uploadedImage;

      if (!image) {
        throw new AppError('An image file is required.', 400);
      }

      const uploadedImage = await uploadImageToImgBB(
        image,
        env.IMGBB_API_KEY,
      );
      response.status(201).json({ success: true, image: uploadedImage });
    },
  );

  return router;
}
