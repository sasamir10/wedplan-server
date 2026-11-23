/* import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const dnsServerSchema = z
    .string()
    .trim()
    .min(1)
    .transform((value) => value.split(",").map((server) => server.trim()))
    .pipe(z.array(z.union([z.ipv4(), z.ipv6()])).min(1));

const optionalCredentialSchema = z.preprocess((value) => {
    if (typeof value !== "string") {
        return value;
    }

    const credential = value.trim();
    return credential.length > 0 ? credential : undefined;
}, z.string().min(1).optional());

const environmentSchema = z
    .object({
        PORT: z.coerce.number().int().positive().default(5000),
        NODE_ENV: z
            .enum(["development", "test", "production"])
            .default("development"),
        CLIENT_URL: z.url().default("http://localhost:3000"),

        BETTER_AUTH_SECRET: z.string().min(32),
        BETTER_AUTH_URL: z.string().url(),

        GOOGLE_CLIENT_ID: optionalCredentialSchema,
        GOOGLE_CLIENT_SECRET: optionalCredentialSchema,
        IMGBB_API_KEY: optionalCredentialSchema,

        MONGODB_URI: z
            .url()
            .refine(
                (value) =>
                    value.startsWith("mongodb://") ||
                    value.startsWith("mongodb+srv://"),
                {
                    message: "Must be a valid MongoDB connection URL.",
                },
            ),
        MONGODB_DB_NAME: z.string().trim().min(1, "Database name is required."),
        WEDPLAN_DNS_SERVERS: dnsServerSchema.optional(),
    })
    .superRefine((values, context) => {
        if (
            Boolean(values.GOOGLE_CLIENT_ID) !==
            Boolean(values.GOOGLE_CLIENT_SECRET)
        ) {
            context.addIssue({
                code: "custom",
                path: values.GOOGLE_CLIENT_ID
                    ? ["GOOGLE_CLIENT_SECRET"]
                    : ["GOOGLE_CLIENT_ID"],
                message:
                    "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set to enable Google sign-in.",
            });
        }
    });

const parsedEnvironment = environmentSchema.safeParse(process.env);

if (!parsedEnvironment.success) {
    const issues = parsedEnvironment.error.issues
        .map(
            (issue) =>
                `  - ${issue.path.join(".") || "environment"}: ${issue.message}`,
        )
        .join("\n");

    throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsedEnvironment.data;
 */

import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

// Treat an empty inherited value as unset so it cannot mask the server .env.
if (!process.env.IMGBB_API_KEY?.trim()) {
    delete process.env.IMGBB_API_KEY;
}

dotenv.config({
    path: fileURLToPath(new URL("../../.env", import.meta.url)),
});

export const env = {
    PORT: Number(process.env.PORT) || 5000,
    NODE_ENV: process.env.NODE_ENV || "development",
    CLIENT_URL: process.env.CLIENT_URL || "http://localhost:3000",
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || "",
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL || "",
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID?.trim() || undefined,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET?.trim() || undefined,
    IMGBB_API_KEY: process.env.IMGBB_API_KEY?.trim() || undefined,
    MONGODB_URI: process.env.MONGODB_URI || "",
    MONGODB_DB_NAME: process.env.MONGODB_DB_NAME || "",
    WEDPLAN_DNS_SERVERS: process.env.WEDPLAN_DNS_SERVERS
        ? process.env.WEDPLAN_DNS_SERVERS.split(",")
              .map((server) => server.trim())
              .filter(Boolean)
        : undefined,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || "",
    STRIPE_PRICE_ID_PREMIUM: process.env.STRIPE_PRICE_ID_PREMIUM || "",
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET?.trim() || undefined,
};
