import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  MAX_VALIDATION_INTERVAL_SECONDS,
  MIN_VALIDATION_INTERVAL_SECONDS,
  parseEntitlementState,
  type CredentialMode,
  type BillingEnvironment,
  type EntitlementState,
  type LicenseTerms,
} from "./client-api";

export interface StoredLicenseData {
  serverUrl: string;
  productId: string;
  billingEnvironment: BillingEnvironment;
  releaseVersion: string;
  releasePlatform: string;
  releaseArch: string;
  devicePlatform: string;
  activationId: string;
  credentialMode: CredentialMode;
  signedLicenseToken?: string;
  signingKeyId?: string;
  trustedSigningKeys?: Record<string, string>;
  activatedAt: string;
  lastValidatedAt: string;
  validationIntervalSeconds: number;
  offlineGraceSeconds: number | null;
  lastValidationRequestId?: string;
  lastEntitlementState: EntitlementState;
  licenseExpiresAt: string | null;
  terms: LicenseTerms;
}

export function getConfigDirectory(): string {
  if (process.env.LICENKIT_CONFIG_DIR) return path.resolve(process.env.LICENKIT_CONFIG_DIR);
  return path.join(os.homedir(), ".licenkit");
}

export function getLicenseFilePath(): string {
  return path.join(getConfigDirectory(), "license.json");
}

function normalizeStoredDate(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return Number.isFinite(Date.parse(value)) ? value : null;
  if (!Number.isFinite(value)) return null;
  return new Date(value > 1_000_000_000_000 ? value : value * 1000).toISOString();
}

function normalizeStoredLicenseData(value: unknown): StoredLicenseData | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<StoredLicenseData>;
  const baseIsValid = (
    typeof candidate.serverUrl === "string" &&
    typeof candidate.productId === "string" &&
    (candidate.billingEnvironment === "sandbox" || candidate.billingEnvironment === "live") &&
    typeof candidate.releaseVersion === "string" &&
    typeof candidate.releasePlatform === "string" &&
    typeof candidate.releaseArch === "string" &&
    typeof candidate.devicePlatform === "string" &&
    typeof candidate.activationId === "string" &&
    (candidate.credentialMode === "opaque" || candidate.credentialMode === "signed") &&
    typeof candidate.lastValidatedAt === "string" &&
    Number.isFinite(Date.parse(candidate.lastValidatedAt)) &&
    !!candidate.terms &&
    typeof candidate.terms.max_activations === "number" &&
    Array.isArray(candidate.terms.features)
  );
  if (!baseIsValid) return null;
  const rawTerms = candidate.terms as LicenseTerms & { updates_until?: string | number | null };
  const normalizedTerms: LicenseTerms = {
    max_activations: rawTerms.max_activations,
    features: rawTerms.features,
    updates_until: normalizeStoredDate(rawTerms.updates_until),
  };
  if (
    !Number.isSafeInteger(candidate.validationIntervalSeconds) ||
    Number(candidate.validationIntervalSeconds) < MIN_VALIDATION_INTERVAL_SECONDS ||
    Number(candidate.validationIntervalSeconds) > MAX_VALIDATION_INTERVAL_SECONDS
  ) return null;
  if (
    candidate.offlineGraceSeconds !== null &&
    (!Number.isSafeInteger(candidate.offlineGraceSeconds) || Number(candidate.offlineGraceSeconds) <= 0)
  ) return null;
  if (!("offlineGraceSeconds" in candidate)) return null;
  const licenseExpiresAt = normalizeStoredDate(
    candidate.licenseExpiresAt as string | number | null | undefined
  );
  if (!candidate.lastEntitlementState) return null;
  const state = candidate.lastEntitlementState;
  let parsedState: EntitlementState;
  try {
    parsedState = parseEntitlementState(state);
  } catch {
    return null;
  }
  return {
    ...candidate,
    activatedAt: candidate.activatedAt,
    validationIntervalSeconds: Number(candidate.validationIntervalSeconds),
    offlineGraceSeconds: candidate.offlineGraceSeconds,
    lastEntitlementState: parsedState,
    licenseExpiresAt,
    terms: normalizedTerms,
  } as StoredLicenseData;
}

export function loadStoredLicense(): StoredLicenseData | null {
  const filePath = getLicenseFilePath();
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  const normalized = normalizeStoredLicenseData(parsed);
  if (!normalized) throw new Error(`Stored credential file does not match the LicenKit V1 contract: ${filePath}`);
  return normalized;
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
