import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
    const key = process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY;

    if (!key) {
        throw new Error(
            "YOUTUBE_TOKEN_ENCRYPTION_KEY is not configured."
        );
    }

    const buffer = Buffer.from(key, "hex");

    if (buffer.length !== 32) {
        throw new Error(
            "YOUTUBE_TOKEN_ENCRYPTION_KEY must be exactly 32 bytes."
        );
    }

    return buffer;
}

export function encryptYouTubeToken(value: string): string {
    const key = getEncryptionKey();

    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(
        ALGORITHM,
        key,
        iv
    );

    const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return [
        iv.toString("hex"),
        authTag.toString("hex"),
        encrypted.toString("hex"),
    ].join(":");
}

export function decryptYouTubeToken(value: string): string {
    const key = getEncryptionKey();

    const [ivHex, authTagHex, encryptedHex] =
        value.split(":");

    if (!ivHex || !authTagHex || !encryptedHex) {
        throw new Error("Invalid encrypted YouTube token.");
    }

    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const encrypted = Buffer.from(encryptedHex, "hex");

    if (
        iv.length !== IV_LENGTH ||
        authTag.length !== AUTH_TAG_LENGTH
    ) {
        throw new Error("Invalid encrypted YouTube token.");
    }

    const decipher = crypto.createDecipheriv(
        ALGORITHM,
        key,
        iv
    );

    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
    ]);

    return decrypted.toString("utf8");
}