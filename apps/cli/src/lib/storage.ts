import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface StoredLicenseData {
  serverUrl: string;
  accountId: string;
  productId?: string;
  machineId: string;
  machineToken: string;
  token: string;
  publicKey?: string;
  activatedAt?: string;
  lastValidatedAt?: string;
  tokenExpiresAt?: string | number;
  licenseExpiresAt?: string | number | null;
  policy?: {
    name: string;
    maxMachines: number;
    offlineGracePeriod: number;
    features: string[];
  };
}

export function getConfigDirectory(): string {
  if (process.env.LICENKIT_CONFIG_DIR) {
    return path.resolve(process.env.LICENKIT_CONFIG_DIR);
  }
  return path.join(os.homedir(), ".licenkit");
}

export function getLicenseFilePath(): string {
  return path.join(getConfigDirectory(), "license.json");
}

export function loadStoredLicense(): StoredLicenseData | null {
  const filePath = getLicenseFilePath();
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as StoredLicenseData;
  } catch {
    return null;
  }
}

export function saveStoredLicense(data: StoredLicenseData): void {
  const configDir = getConfigDirectory();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const filePath = getLicenseFilePath();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function clearStoredLicense(): boolean {
  const filePath = getLicenseFilePath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}
