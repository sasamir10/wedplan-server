import { APIError } from "better-auth/api";

const signupRoles = ["customer", "vendor"] as const;
const MAX_BUSINESS_NAME_LENGTH = 100;

export type SignupRole = (typeof signupRoles)[number];

type UserHookContext = { path?: string } | null;
type UserHookData = Record<string, unknown>;

function isSignupRole(value: unknown): value is SignupRole {
    return signupRoles.some((role) => role === value);
}

function normalizeBusinessName(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const businessName = value.trim();

    if (
        businessName.length === 0 ||
        businessName.length > MAX_BUSINESS_NAME_LENGTH
    ) {
        return null;
    }

    return businessName;
}

/** Keeps the public registration password rules aligned with the client form. */
export function validateSignupPassword(password: unknown): void {
    if (
        typeof password !== "string" ||
        !/[A-Z]/.test(password) ||
        !/[a-z]/.test(password)
    ) {
        throw APIError.from("BAD_REQUEST", {
            code: "INVALID_PASSWORD",
            message:
                "Password must contain at least one uppercase and one lowercase letter.",
        });
    }
}

/** Prevents blocked users from receiving new Better Auth sessions. */
export function assertUserCanCreateSession(isBlocked: unknown): void {
    if (isBlocked === true) {
        throw APIError.from("FORBIDDEN", {
            code: "BANNED_USER",
            message: "This account is unavailable.",
        });
    }
}

export async function beforeUserCreate(
    user: UserHookData,
    context: UserHookContext,
): Promise<{ data: UserHookData }> {
    const {
        signupRole,
        signupBusinessName,
        businessName: _ignoredBusinessName,
        ...userData
    } = user;

    if (context?.path !== "/sign-up/email") {
        return { data: userData };
    }

    if (user.role === "admin") {
        throw new APIError("FORBIDDEN", {
            message: "Public registration cannot assign the admin role.",
        });
    }

    if (!isSignupRole(signupRole)) {
        throw new APIError("BAD_REQUEST", {
            message: "Choose a valid signup role: customer or vendor.",
        });
    }

    const businessName = normalizeBusinessName(signupBusinessName);

    if (signupRole === "vendor" && !businessName) {
        throw new APIError("BAD_REQUEST", {
            message: "A valid business name is required for vendors.",
        });
    }

    return {
        data: {
            ...userData,
            role: signupRole,
            ...(signupRole === "vendor" && businessName
                ? { businessName }
                : {}),
        },
    };
}

export async function beforeUserUpdate(user: UserHookData): Promise<void> {
    const protectedFields = [
        "role",
        "signupRole",
        "signupBusinessName",
        "businessName",
    ];

    if (protectedFields.some((field) => field in user)) {
        throw new APIError("FORBIDDEN", {
            message:
                "Protected account fields cannot be changed through this endpoint.",
        });
    }
}
