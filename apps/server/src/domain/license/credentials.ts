import { sha256Hex } from "../../infra/crypto";

export async function hashDeviceFingerprint(fingerprint: string): Promise<string> {
  return sha256Hex(fingerprint.trim());
}

export function normalizeCustomerEmail(email: string): string {
  return email.trim().toLowerCase();
}
