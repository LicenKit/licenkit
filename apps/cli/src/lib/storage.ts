import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { CredentialMode, LicenseTerms } from "./client-api";

export interface StoredLicenseData {
  serverUrl: string;
  accountId: string;
  productId: string;
  releaseVersion: string;
  releasePlatform: string;
  devicePlatform: string;
  activationId: string;
  machineToken: string;
  credentialMode: CredentialMode;
  signedLicenseToken?: string;
  signingKeyId?: string;
  trustedSigningKeys?: Record<string, string>;
  activatedAt: string;
  lastValidatedAt: string;
  licenseExpiresAt: string | number | null;
  terms: LicenseTerms;
}

export function getConfigDirectory(): string {
  if (process.env.LICENKIT_CONFIG_DIR) return path.resolve(process.env.LICENKIT_CONFIG_DIR);
  return path.join(os.homedir(), ".licenkit");
}

export function getLicenseFilePath(): string {
  return path.join(getConfigDirectory(), "license.json");
}

function isStoredLicenseData(value: unknown): value is StoredLicenseData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredLicenseData>;
  return (
    typeof candidate.serverUrl === "string" &&
    typeof candidate.accountId === "string" &&
    typeof candidate.productId === "string" &&
    typeof candidate.releaseVersion === "string" &&
    typeof candidate.releasePlatform === "string" &&
    typeof candidate.activationId === "string" &&
    typeof candidate.machineToken === "string" &&
    (candidate.credentialMode === "opaque" || candidate.credentialMode === "signed") &&
    !!candidate.terms
  );
}

export function loadStoredLicense(): StoredLicenseData | null {
  const filePath = getLicenseFilePath();
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  if (!isStoredLicenseData(parsed)) throw new Error(`Stored credential file does not match the LicenKit V1 contract: ${filePath}`);
  return parsed;
}

export function saveStoredLicense(data: StoredLicenseData): void {
  const configDir = getConfigDirectory();
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const filePath = getLicenseFilePath();
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

export function clearStoredLicense(): boolean {
  const filePath = getLicenseFilePath();
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}
