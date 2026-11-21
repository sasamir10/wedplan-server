import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import { authorizeRoles } from '../src/middleware/authorize.js';
import type { AuthenticatedIdentity } from '../src/middleware/authenticate.js';
import { AppError } from '../src/utils/app-error.js';
import {
  MAX_IMAGE_UPLOAD_BYTES,
  receiveImageUpload,
  type UploadedImage,
} from '../src/middleware/image-upload.js';
import {
  detectImageMimeType,
  uploadImageToImgBB,
} from '../src/services/image-upload.service.js';

const validPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/QG0AAAAASUVORK5CYII=',
  'base64',
);

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

function multipartFile(
  bytes: Buffer,
  mimeType = 'image/png',
  fieldName = 'image',
  filename = 'vendor-file.png',
): { body: Buffer; contentType: string } {
  const boundary = 'wedplan-upload-test-boundary';
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([prefix, bytes, suffix]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function runUploadParser(body: Buffer, contentType: string) {
  return new Promise<{ error?: unknown; image?: UploadedImage }>((resolve) => {
    const request = Readable.from([body]) as unknown as Request;
    Object.defineProperty(request, 'headers', {
      value: { 'content-type': contentType },
    });
    (request as unknown as { get: (name: string) => string | undefined }).get = (name) =>
      name.toLowerCase() === 'content-type' ? contentType : undefined;

    receiveImageUpload(request, {} as ExpressResponse, (error?: unknown) => {
      resolve({ error, image: request.uploadedImage });
    });
  });
}

function expectAppError(error: unknown, statusCode: number, forbiddenContent: string[] = []): void {
  assert.ok(error instanceof AppError);
  assert.equal(error.statusCode, statusCode);
  for (const content of forbiddenContent) {
    assert.equal(error.message.includes(content), false);
    assert.equal(error.stack?.includes(content), false);
  }
}

function mockImgBBResponse(overrides: Record<string, unknown> = {}): FetchResponse {
  const responseBody = {
    success: true,
    data: {
      id: 'safe-image-id',
      url: 'https://i.ibb.co/abc123/vendor-image.png',
      size: '68',
      image: { mime: 'image/png' },
      ...overrides,
    },
  };
  return new globalThis.Response(JSON.stringify(responseBody), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const validUpload: UploadedImage = {
  buffer: validPng,
  mimeType: 'image/png',
};

test('parses a single supported image from in-memory multipart form data', async () => {
  const upload = multipartFile(validPng);
  const result = await runUploadParser(upload.body, upload.contentType);

  assert.equal(result.error, undefined);
  assert.equal(result.image?.mimeType, 'image/png');
  assert.deepEqual(result.image?.buffer, validPng);
});

test('vendor upload authorization allows vendors and rejects customers or missing identity', () => {
  const vendorIdentity: AuthenticatedIdentity = {
    id: 'verified-vendor-id',
    email: 'vendor@example.com',
    role: 'vendor',
    isBlocked: false,
    issuedAt: 1_700_000_000,
    expiresAt: 1_700_000_900,
  };

  function authorize(identity?: AuthenticatedIdentity) {
    let forwardedError: unknown;
    const request = { authenticatedUser: identity } as Request;
    const next = ((error?: unknown) => {
      forwardedError = error;
    }) as NextFunction;

    authorizeRoles('vendor')(request, {} as ExpressResponse, next);
    return forwardedError;
  }

  assert.equal(authorize(vendorIdentity), undefined);
  const customerError = authorize({ ...vendorIdentity, role: 'customer' });
  assert.ok(customerError instanceof AppError);
  assert.equal(customerError.statusCode, 403);
  const unauthenticatedError = authorize();
  assert.ok(unauthenticatedError instanceof AppError);
  assert.equal((unauthenticatedError as AppError).statusCode, 401);
});

test('rejects a missing multipart image', async () => {
  const boundary = 'wedplan-empty-upload';
  const body = Buffer.from(`--${boundary}--\r\n`);
  const result = await runUploadParser(body, `multipart/form-data; boundary=${boundary}`);

  expectAppError(result.error, 400);
});

test('rejects text fields and remote image URLs', async () => {
  const boundary = 'wedplan-remote-url-upload';
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"\r\n\r\nhttps://images.example.com/image.png\r\n--${boundary}--\r\n`,
  );
  const result = await runUploadParser(body, `multipart/form-data; boundary=${boundary}`);

  expectAppError(result.error, 400);
});

test('rejects unsupported image MIME types such as SVG', async () => {
  const upload = multipartFile(Buffer.from('<svg/>'), 'image/svg+xml', 'image', 'vector.svg');
  const result = await runUploadParser(upload.body, upload.contentType);

  expectAppError(result.error, 415);
});

test('rejects malformed or non-multipart uploads', async () => {
  const result = await runUploadParser(Buffer.from('image bytes'), 'application/octet-stream');

  expectAppError(result.error, 400);
});

test('rejects a multipart request with a truncated boundary', async () => {
  const upload = multipartFile(validPng);
  const truncatedBody = upload.body.subarray(0, upload.body.length - 8);
  const result = await runUploadParser(truncatedBody, upload.contentType);

  expectAppError(result.error, 400);
});

test('recognizes JPEG, PNG, and WebP signatures from file bytes', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]);
  const webp = Buffer.alloc(32);
  webp.write('RIFF', 0, 'ascii');
  webp.writeUInt32LE(webp.length - 8, 4);
  webp.write('WEBP', 8, 'ascii');
  webp.write('VP8 ', 12, 'ascii');
  webp.writeUInt32LE(12, 16);

  assert.equal(detectImageMimeType(jpeg), 'image/jpeg');
  assert.equal(detectImageMimeType(validPng), 'image/png');
  assert.equal(detectImageMimeType(webp), 'image/webp');
  assert.equal(detectImageMimeType(Buffer.from('<svg/>')), null);
});

test('rejects files above the 10 MB limit while streaming', async () => {
  const upload = multipartFile(Buffer.alloc(MAX_IMAGE_UPLOAD_BYTES + 1, 0x61));
  const result = await runUploadParser(upload.body, upload.contentType);

  expectAppError(result.error, 413);
});

test('uploads a validated image and returns only safe ImgBB metadata', async () => {
  const apiKey = 'server-only-test-key';
  let calledUrl: URL | undefined;
  let calledInit: RequestInit | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    calledUrl = new URL(input.toString());
    calledInit = init;
    return mockImgBBResponse();
  };

  const result = await uploadImageToImgBB(validUpload, apiKey, fetcher);

  assert.equal(calledUrl?.origin, 'https://api.imgbb.com');
  assert.equal(calledUrl?.pathname, '/1/upload');
  assert.equal(calledUrl?.searchParams.get('key'), apiKey);
  assert.equal(calledInit?.method, 'POST');
  assert.equal(calledInit?.redirect, 'error');
  assert.ok(calledInit?.body instanceof FormData);
  assert.deepEqual(result, {
    url: 'https://i.ibb.co/abc123/vendor-image.png',
    mimeType: 'image/png',
    sizeBytes: 68,
  });
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test('rejects a spoofed MIME type when the file signature is invalid', async () => {
  let fetchCalled = false;
  const fetcher: typeof fetch = async () => {
    fetchCalled = true;
    return mockImgBBResponse();
  };

  await assert.rejects(
    () => uploadImageToImgBB({ buffer: Buffer.from('not a PNG'), mimeType: 'image/png' }, 'key', fetcher),
    (error: unknown) => {
      expectAppError(error, 400);
      return true;
    },
  );
  assert.equal(fetchCalled, false);
});

test('rejects valid image bytes when their declared MIME type disagrees', async () => {
  await assert.rejects(
    () => uploadImageToImgBB({ buffer: validPng, mimeType: 'image/jpeg' }, 'key'),
    (error: unknown) => {
      expectAppError(error, 400);
      return true;
    },
  );
});

test('returns service unavailable when the ImgBB API key is missing', async () => {
  let fetchCalled = false;
  const fetcher: typeof fetch = async () => {
    fetchCalled = true;
    return mockImgBBResponse();
  };

  await assert.rejects(
    () => uploadImageToImgBB(validUpload, undefined, fetcher),
    (error: unknown) => {
      expectAppError(error, 503);
      return true;
    },
  );
  assert.equal(fetchCalled, false);
});

test('maps ImgBB rejection to a safe gateway error without upstream details or key', async () => {
  const apiKey = 'never-return-this-key';
  const fetcher: typeof fetch = async () =>
    new globalThis.Response(`provider error details ${apiKey}`, { status: 400 });

  await assert.rejects(
    () => uploadImageToImgBB(validUpload, apiKey, fetcher),
    (error: unknown) => {
      expectAppError(error, 502, [apiKey, 'provider error details']);
      return true;
    },
  );
});

test('maps ImgBB network failure and timeout to safe errors', async () => {
  const networkFailure: typeof fetch = async () => {
    throw new Error('private upstream endpoint and credentials');
  };
  const timeout: typeof fetch = async () => {
    throw new DOMException('private timeout details', 'TimeoutError');
  };

  await assert.rejects(
    () => uploadImageToImgBB(validUpload, 'key', networkFailure),
    (error: unknown) => {
      expectAppError(error, 502, ['private upstream endpoint', 'credentials']);
      return true;
    },
  );
  await assert.rejects(
    () => uploadImageToImgBB(validUpload, 'key', timeout),
    (error: unknown) => {
      expectAppError(error, 504, ['private timeout details']);
      return true;
    },
  );

  const responseBodyTimeout: typeof fetch = async () => ({
    ok: true,
    json: async () => {
      throw new DOMException('private response timeout details', 'TimeoutError');
    },
  }) as unknown as FetchResponse;

  await assert.rejects(
    () => uploadImageToImgBB(validUpload, 'key', responseBodyTimeout),
    (error: unknown) => {
      expectAppError(error, 504, ['private response timeout details']);
      return true;
    },
  );
});

test('rejects malformed ImgBB responses without exposing response details or key', async () => {
  const apiKey = 'private-imgbb-api-key';
  const fetcher: typeof fetch = async () =>
    new globalThis.Response(JSON.stringify({
      success: false,
      error: { message: `sensitive provider detail ${apiKey}` },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  await assert.rejects(
    () => uploadImageToImgBB(validUpload, apiKey, fetcher),
    (error: unknown) => {
      expectAppError(error, 502, [apiKey, 'sensitive provider detail']);
      return true;
    },
  );
});

test('rejects an ImgBB response URL outside the direct image host', async () => {
  const fetcher: typeof fetch = async () =>
    mockImgBBResponse({ url: 'https://attacker.example/redirect' });

  await assert.rejects(
    () => uploadImageToImgBB(validUpload, 'key', fetcher),
    (error: unknown) => {
      expectAppError(error, 502);
      return true;
    },
  );
});

test('never returns an ImgBB URL containing the configured API key', async () => {
  const apiKey = 'private-api-key-value';
  const fetcher: typeof fetch = async () =>
    mockImgBBResponse({ url: `https://i.ibb.co/abc123/${apiKey}.png` });

  await assert.rejects(
    () => uploadImageToImgBB(validUpload, apiKey, fetcher),
    (error: unknown) => {
      expectAppError(error, 502, [apiKey]);
      return true;
    },
  );
});

