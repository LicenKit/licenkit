/**
 * Automated Verification Script: Zero In-Code Secrets & Fail-Fast Environment Validation
 */

import { getStorageEncryptionKey, getJwtSecret } from "../apps/server/src/infra/crypto/index.ts";

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${message}`);
    process.exit(1);
  }
  console.log(`  ✓ ${message}`);
}

async function runTests() {
  console.log("\n=======================================================");
  console.log("🔒 Running Zero In-Code Secrets & Environment Security Test");
  console.log("=======================================================\n");

  // 1. STORAGE_ENCRYPTION_KEY validation
  console.log("--- 1. Testing STORAGE_ENCRYPTION_KEY Fail-Fast Validation ---");
  let caughtMissingStorage = false;
  try {
    getStorageEncryptionKey({});
  } catch (err) {
    caughtMissingStorage = true;
    assert(err.message.includes("STORAGE_ENCRYPTION_KEY is required"), "Missing storage key throws configuration error");
  }
  assert(caughtMissingStorage, "Missing STORAGE_ENCRYPTION_KEY failed fast without fallback");

  let caughtShortStorage = false;
  try {
    getStorageEncryptionKey({ STORAGE_ENCRYPTION_KEY: "short_key_10" });
  } catch (err) {
    caughtShortStorage = true;
    assert(err.message.includes("at least 16 characters"), "Short storage key rejected (< 16 bytes)");
  }
  assert(caughtShortStorage, "Insecure short storage key rejected");

  const validKey = getStorageEncryptionKey({ STORAGE_ENCRYPTION_KEY: "valid_secure_master_key_32_bytes" });
  assert(validKey === "valid_secure_master_key_32_bytes", "Valid storage encryption key accepted");

  // 2. JWT_SECRET validation
  console.log("\n--- 2. Testing JWT_SECRET Fail-Fast Validation ---");
  let caughtMissingJwt = false;
  try {
    getJwtSecret({});
  } catch (err) {
    caughtMissingJwt = true;
    assert(err.message.includes("JWT_SECRET is required"), "Missing JWT secret throws configuration error");
  }
  assert(caughtMissingJwt, "Missing JWT_SECRET failed fast without fallback");

  let caughtShortJwt = false;
  try {
    getJwtSecret({ JWT_SECRET: "short_jwt" });
  } catch (err) {
    caughtShortJwt = true;
    assert(err.message.includes("at least 16 characters"), "Short JWT secret rejected (< 16 bytes)");
  }
  assert(caughtShortJwt, "Insecure short JWT secret rejected");

  const validJwt = getJwtSecret({ JWT_SECRET: "valid_secure_jwt_secret_32_bytes" });
  assert(validJwt === "valid_secure_jwt_secret_32_bytes", "Valid JWT secret accepted");

  console.log("\n=======================================================");
  console.log("🎉 ALL ENVIRONMENT & SECRET SECURITY TESTS PASSED 100%");
  console.log("=======================================================\n");
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
