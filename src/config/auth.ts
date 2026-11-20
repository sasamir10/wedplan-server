import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { createAuthMiddleware } from "better-auth/api";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import type { Db, MongoClient } from "mongodb";
import {
    assertUserCanCreateSession,
    beforeUserCreate,
    beforeUserUpdate,
    validateSignupPassword,
} from "./auth-hooks.js";
import { env } from "./env.js";

/** Creates the Better Auth instance using WedPlan's already-connected MongoDB resources. */
export function createAuth(database: Db, client: MongoClient) {
    return betterAuth({
        database: mongodbAdapter(database, { client }),
        secret: env.BETTER_AUTH_SECRET,
        baseURL: env.BETTER_AUTH_URL,
        trustedOrigins: [env.CLIENT_URL],
        emailAndPassword: {
            enabled: true,
            minPasswordLength: 8,
            maxPasswordLength: 128,
        },
        ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
            ? {
                  socialProviders: {
                      google: {
                          clientId: env.GOOGLE_CLIENT_ID,
                          clientSecret: env.GOOGLE_CLIENT_SECRET,
                      },
                  },
              }
            : {}),

        user: {
            additionalFields: {
                role: {
                    type: ["customer", "vendor", "admin"],
                    required: true,
                    defaultValue: "customer",
                    input: false,
                },
                signupRole: {
                    type: ["customer", "vendor"],
                    required: false,
                    input: true,
                },
                signupBusinessName: {
                    type: "string",
                    required: false,
                    input: true,
                },
                isBlocked: {
                    type: "boolean",
                    required: true,
                    defaultValue: false,
                    input: false,
                },
                businessName: {
                    type: "string",
                    required: false,
                    input: false,
                },
                subscriptionPlan: {
                    type: ["free", "premium"],
                    required: true,
                    defaultValue: "free",
                    input: false,
                },
                subscriptionExpiresAt: {
                    type: "date",
                    required: false,
                    input: false,
                },
            },
        },

        databaseHooks: {
            user: {
                create: {
                    before: beforeUserCreate,
                },
                update: {
                    before: beforeUserUpdate,
                },
            },
            session: {
                create: {
                    before: async (session, context) => {
                        if (!context) {
                            return;
                        }

                        const user = await context.context.internalAdapter.findUserById(
                            session.userId,
                        );

                        if (user) {
                            assertUserCanCreateSession(
                                "isBlocked" in user ? user.isBlocked : undefined,
                            );
                        }
                    },
                },
            },
        },
        hooks: {
            before: createAuthMiddleware(async (context) => {
                if (context.path === "/sign-up/email") {
                    validateSignupPassword(context.body.password);
                }
            }),
        },
        plugins: [
            jwt({
                jwks: {
                    keyPairConfig: {
                        alg: "EdDSA",
                        crv: "Ed25519",
                    },
                },
                jwt: {
                    issuer: env.BETTER_AUTH_URL,
                    audience: env.BETTER_AUTH_URL,
                    expirationTime: "15m",
                    definePayload: ({ user }) => ({
                        email: user.email,
                        role: user.role,
                        isBlocked: user.isBlocked,
                    }),
                },
            }),
        ],
    });
}

export type WedPlanAuth = ReturnType<typeof createAuth>;
