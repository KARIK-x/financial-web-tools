import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const KEYLEN = 64;
const PARAMS = { N: 16384, r: 8, p: 1 };

/** scrypt password hashing with per-password salt. Format: scrypt$N$r$p$salt$hash */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize("NFKC"), salt, KEYLEN);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  if (!n || !r || !p || !saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const derived = await scrypt(password.normalize("NFKC"), salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function passwordIssues(password: string): string[] {
  const issues: string[] = [];
  if (password.length < 12) issues.push("Use at least 12 characters.");
  if (!/[a-zA-Z]/.test(password)) issues.push("Include at least one letter.");
  if (!/[0-9]/.test(password)) issues.push("Include at least one number.");
  if (/^(password|123456|qwerty)/i.test(password)) issues.push("Avoid common passwords.");
  return issues;
}
