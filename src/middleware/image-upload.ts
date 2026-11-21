import Busboy from "busboy";
import type { RequestHandler } from "express";
import { AppError } from "../utils/app-error.js";

export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

export type SupportedImageMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface UploadedImage {
    buffer: Buffer;
    mimeType: SupportedImageMimeType;
}

declare global {
    namespace Express {
        interface Request {
            uploadedImage?: UploadedImage;
        }
    }
}

const supportedMimeTypes = new Set<string>([
    "image/jpeg",
    "image/png",
    "image/webp",
]);

export const receiveImageUpload: RequestHandler = (
    request,
    _response,
    next,
) => {
    const contentType = request.get("content-type") ?? "";

    if (!/^multipart\/form-data\s*;/i.test(contentType)) {
        return next(new AppError("A multipart image upload is required.", 400));
    }

    let parser: ReturnType<typeof Busboy>;
    try {
        parser = Busboy({
            headers: request.headers,
            limits: {
                fileSize: MAX_IMAGE_UPLOAD_BYTES,
                files: 1,
                fields: 0,
                parts: 2,
                fieldNameSize: 50,
                headerPairs: 20,
            },
        });
    } catch {
        return next(new AppError("Malformed multipart image upload.", 400));
    }

    let uploadError: AppError | undefined;
    let image: UploadedImage | undefined;
    let fileCount = 0;
    let settled = false;

    const setUploadError = (error: AppError) => {
        uploadError ??= error;
    };

    const finish = (error?: AppError) => {
        if (settled) return;
        settled = true;

        const finalError = error ?? uploadError;
        if (finalError) {
            next(finalError);
            return;
        }

        if (fileCount !== 1 || !image) {
            next(new AppError("An image file is required.", 400));
            return;
        }

        request.uploadedImage = image;
        next();
    };

    parser.on("file", (fieldName, file, info) => {
        fileCount += 1;

        if (fieldName !== "image") {
            setUploadError(
                new AppError(
                    "Upload exactly one file using the image field.",
                    400,
                ),
            );
        }

        if (!supportedMimeTypes.has(info.mimeType)) {
            setUploadError(
                new AppError(
                    "Only JPEG, PNG, and WebP images are supported.",
                    415,
                ),
            );
        }

        const chunks: Buffer[] = [];
        file.on("data", (chunk: Buffer) => {
            if (
                !uploadError &&
                fieldName === "image" &&
                supportedMimeTypes.has(info.mimeType)
            ) {
                chunks.push(chunk);
            }
        });
        file.once("limit", () => {
            setUploadError(
                new AppError("Image uploads must be 10 MB or smaller.", 413),
            );
        });
        file.on("error", () => {
            setUploadError(
                new AppError("Malformed multipart image upload.", 400),
            );
        });
        file.once("end", () => {
            if (
                !uploadError &&
                fieldName === "image" &&
                supportedMimeTypes.has(info.mimeType) &&
                !file.truncated
            ) {
                image = {
                    buffer: Buffer.concat(chunks),
                    mimeType: info.mimeType as SupportedImageMimeType,
                };
            }
        });
    });

    parser.on("field", () => {
        setUploadError(
            new AppError("Only the image file field is accepted.", 400),
        );
    });
    parser.on("filesLimit", () => {
        setUploadError(new AppError("Upload exactly one image.", 400));
    });
    parser.on("fieldsLimit", () => {
        setUploadError(
            new AppError("Only the image file field is accepted.", 400),
        );
    });
    parser.on("partsLimit", () => {
        setUploadError(
            new AppError(
                "Upload exactly one image without additional fields.",
                400,
            ),
        );
    });
    parser.on("error", () => {
        request.unpipe(parser);
        finish(new AppError("Malformed multipart image upload.", 400));
    });
    parser.once("close", () => {
        finish();
    });

    request.once("error", () => {
        request.unpipe(parser);
        finish(new AppError("Malformed multipart image upload.", 400));
    });
    request.pipe(parser);
};
