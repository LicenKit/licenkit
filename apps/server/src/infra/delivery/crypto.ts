import {
  base64ToBuffer,
  bufferToBase64,
  getStorageEncryptionKey,
} from "../crypto";

interface EnvelopeV1 {
  v: 1;
  kid: string;
  nonce: string;
  ciphertext: string;
}

export type EnvelopeIdentity = ({ instanceId: string; scope?: never } | { scope: "identity"; instanceId?: never }) & {
  table: string;
  rowId: string;
  field: string;
}

export interface DeliveryCryptoEnv {
  STORAGE_ENCRYPTION_KEY?: string;
  STORAGE_ENCRYPTION_KEY_ID?: string;
}

function aadFor(identity: EnvelopeIdentity): string {
  return [identity.scope === "identity" ? "identity" : identity.instanceId, identity.table, identity.rowId, identity.field].join("\u001f");
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptEnvelopeV1(
  plaintext: string,
  env: DeliveryCryptoEnv,
  identity: EnvelopeIdentity
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(getStorageEncryptionKey(env));
  const additionalData = new TextEncoder().encode(aadFor(identity));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData },
    key,
    new TextEncoder().encode(plaintext)
  );
  const envelope: EnvelopeV1 = {
    v: 1,
    kid: env.STORAGE_ENCRYPTION_KEY_ID?.trim() || "primary",
    nonce: bufferToBase64(nonce),
    ciphertext: bufferToBase64(ciphertext),
  };
  return JSON.stringify(envelope);
}

export async function decryptEnvelopeV1(
  serialized: string,
  env: DeliveryCryptoEnv,
  identity: EnvelopeIdentity
): Promise<string> {
  let envelope: EnvelopeV1;
  try {
    envelope = JSON.parse(serialized) as EnvelopeV1;
  } catch {
    throw new Error("DELIVERY_ENVELOPE_INVALID_JSON");
  }
  if (
    envelope.v !== 1 ||
    typeof envelope.kid !== "string" ||
    typeof envelope.nonce !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("DELIVERY_ENVELOPE_UNSUPPORTED");
  }
  const configuredKeyId = env.STORAGE_ENCRYPTION_KEY_ID?.trim() || "primary";
  if (envelope.kid !== configuredKeyId) {
    throw new Error(`DELIVERY_ENVELOPE_KEY_NOT_AVAILABLE:${envelope.kid}`);
  }
  const nonce = base64ToBuffer(envelope.nonce);
  if (nonce.byteLength !== 12) throw new Error("DELIVERY_ENVELOPE_NONCE_INVALID");
  try {
    const key = await deriveKey(getStorageEncryptionKey(env));
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: new TextEncoder().encode(aadFor(identity)),
      },
      key,
      base64ToBuffer(envelope.ciphertext)
    );
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("DELIVERY_")) throw error;
    throw new Error("DELIVERY_ENVELOPE_AUTHENTICATION_FAILED");
  }
}
