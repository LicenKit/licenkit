import pkg from "node-machine-id";
import os from "node:os";

const machineIdSync =
  typeof (pkg as any).machineIdSync === "function"
    ? (pkg as any).machineIdSync
    : typeof (pkg as any).default?.machineIdSync === "function"
    ? (pkg as any).default.machineIdSync
    : pkg;

/**
 * Fallback algorithm: compute deterministic SHA-256 hash using network MAC addresses and hostname.
 */
async function computeFallbackFingerprint(): Promise<string> {
  const interfaces = os.networkInterfaces();
  const macAddresses: string[] = [];

  for (const name of Object.keys(interfaces)) {
    const netList = interfaces[name];
    if (netList) {
      for (const net of netList) {
        if (!net.internal && net.mac && net.mac !== "00:00:00:00:00:00") {
          macAddresses.push(net.mac.toLowerCase());
        }
      }
    }
  }

  const rawSeed = `${os.hostname()}:${os.platform()}:${macAddresses.sort().join(",")}`;
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(rawSeed));
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Retrieves the unique, persistent hardware fingerprint for the host machine.
 * Uses native OS primitives:
 * - macOS: IOPlatformUUID
 * - Windows: MachineGuid (Registry)
 * - Linux: /etc/machine-id
 */
export async function getMachineFingerprint(): Promise<string> {
  try {
    const rawId = machineIdSync({ original: true });
    if (rawId && rawId.length >= 8) {
      return rawId.trim();
    }
  } catch {}

  // Safe fallback if raw OS primitive query was blocked by sandbox
  return await computeFallbackFingerprint();
}

/**
 * Returns basic operating system and device metadata for licensing inspection.
 */
export async function getDeviceMetadata(): Promise<{
  fingerprint: string;
  platform: string;
  hostname: string;
  arch: string;
  osType: string;
  osRelease: string;
}> {
  const fingerprint = await getMachineFingerprint();
  return {
    fingerprint,
    platform: os.platform(),
    hostname: os.hostname(),
    arch: os.arch(),
    osType: os.type(),
    osRelease: os.release(),
  };
}
