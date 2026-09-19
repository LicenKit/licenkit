import { bufferToHex, sha256Hex } from "../../infra/crypto";

export function generateTrialToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `ttk_${bufferToHex(bytes)}`;
}

export function generateOpaqueMachineToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `mtk_${bufferToHex(bytes)}`;
}

export async function hashDeviceFingerprint(fingerprint: string): Promise<string> {
  return sha256Hex(fingerprint.trim());
}

export async function hashTrialToken(token: string): Promise<string> {
  return sha256Hex(token);
}

export function normalizeCustomerEmail(email: string): string {
  return email.trim().toLowerCase();
}
