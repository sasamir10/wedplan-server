import { z } from "zod";
import type {
    SupportedImageMimeType,
    UploadedImage,
} from "../middleware/image-upload.js";
import { AppError } from "../utils/app-error.js";

const IMGBB_UPLOAD_ENDPOINT = "https://api.imgbb.com/1/upload";
const IMGBB_TIMEOUT_MS = 15_000;

const imageMimeTypes = ["image/jpeg", "image/png", "image/webp"] as const;

const hostedImageUrlSchema = z
    .string()
    .url()
    .refine((value) => {
        const url = new URL(value);
        return (
            url.protocol === "https:" &&
            url.hostname === "i.ibb.co" &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
        );
    });

const imageSizeSchema = z
    .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
    .pipe(z.number().int().positive());

const imgbbResponseSchema = z.object({
    success: z.literal(true),
    data: z.object({
        id: z.string().min(1).max(100),
        url: hostedImageUrlSchema,
        size: imageSizeSchema,
        image: z.object({
            mime: z.enum(imageMimeTypes),
        }),
    }),
});

export interface UploadedImageResult {
    url: string;
    mimeType: SupportedImageMimeType;
    sizeBytes: number;
}

export function detectImageMimeType(
    buffer: Buffer,
): SupportedImageMimeType | null {
    if (
        buffer.length >= 4 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff &&
        buffer[buffer.length - 2] === 0xff &&
        buffer[buffer.length - 1] === 0xd9
    ) {
        return "image/jpeg";
    }

    const isPngSignature = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    if (
        buffer.length >= 24 &&
        buffer.subarray(0, 8).equals(isPngSignature) &&
        buffer.readUInt32BE(8) === 13 &&
        buffer.toString("ascii", 12, 16) === "IHDR" &&
        buffer.readUInt32BE(16) > 0 &&
        buffer.readUInt32BE(20) > 0 &&
        buffer.includes(Buffer.from("IDAT")) &&
        buffer
            .subarray(-12)
            .equals(
                Buffer.from([
                    0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
                ]),
            )
    ) {
        return "image/png";
    }

    if (
        buffer.length >= 20 &&
        buffer.toString("ascii", 0, 4) === "RIFF" &&
        buffer.toString("ascii", 8, 12) === "WEBP" &&
        buffer.readUInt32LE(4) + 8 <= buffer.length &&
        ["VP8 ", "VP8L", "VP8X"].includes(buffer.toString("ascii", 12, 16)) &&
        buffer.readUInt32LE(16) > 0 &&
        20 + buffer.readUInt32LE(16) <= buffer.length
    ) {
        return "image/webp";
    }

    return null;
}

function assertSupportedImageContent(image: UploadedImage): void {
    const actualMimeType = detectImageMimeType(image.buffer);

    if (!actualMimeType) {
        throw new AppError("The uploaded file is not a supported image.", 400);
    }

    if (actualMimeType !== image.mimeType) {
        throw new AppError(
            "The uploaded image content does not match its declared type.",
            400,
        );
    }
}

function getImageExtension(mimeType: SupportedImageMimeType): string {
    switch (mimeType) {
        case "image/jpeg":
            return "jpg";
        case "image/png":
            return "png";
        case "image/webp":
            return "webp";
    }
}

function isTimeoutError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
    );
}

export async function uploadImageToImgBB(
    image: UploadedImage,
    apiKey: string | undefined,
    fetcher: typeof fetch = fetch,
): Promise<UploadedImageResult> {
    if (!apiKey?.trim()) {
        throw new AppError("Image uploads are not configured.", 503);
    }

    assertSupportedImageContent(image);

    const endpoint = new URL(IMGBB_UPLOAD_ENDPOINT);
    endpoint.searchParams.set("key", apiKey);

    const form = new FormData();
    form.append(
        "image",
        new Blob([new Uint8Array(image.buffer)], { type: image.mimeType }),
        `upload.${getImageExtension(image.mimeType)}`,
    );

    let response: Response;
    try {
        response = await fetcher(endpoint, {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(IMGBB_TIMEOUT_MS),
            redirect: "error",
        });
    } catch (error) {
        if (isTimeoutError(error)) {
            throw new AppError(
                "Image upload timed out. Please try again.",
                504,
            );
        }

        throw new AppError("The image upload provider is unavailable.", 502);
    }

    if (!response.ok) {
        throw new AppError(
            "The image upload provider could not accept this image.",
            502,
        );
    }

    let responseBody: unknown;
    try {
        responseBody = await response.json();
    } catch (error) {
        if (isTimeoutError(error)) {
            throw new AppError(
                "Image upload timed out. Please try again.",
                504,
            );
        }

        throw new AppError(
            "The image upload provider returned an invalid response.",
            502,
        );
    }

    const parsedResponse = imgbbResponseSchema.safeParse(responseBody);
    if (
        !parsedResponse.success ||
        parsedResponse.data.data.image.mime !== image.mimeType ||
        parsedResponse.data.data.url.includes(apiKey)
    ) {
        throw new AppError(
            "The image upload provider returned an invalid response.",
            502,
        );
    }

    return {
        url: parsedResponse.data.data.url,
        mimeType: parsedResponse.data.data.image.mime,
        sizeBytes: parsedResponse.data.data.size,
    };
}
