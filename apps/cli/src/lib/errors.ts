import { ClientApiError, ClientTransportError } from "./client-api";
import { SignedTokenError } from "./crypto";

export function describeClientError(error: unknown): string[] {
  if (error instanceof ClientApiError) {
    return [
      `Business error [${error.code}]: ${error.message}`,
      ...(error.requestId ? [`Request ID: ${error.requestId}`] : []),
      ...Object.entries(error.details).map(([key, value]) => `${key}: ${value}`),
    ];
  }
  if (error instanceof ClientTransportError) {
    return [
      `Transport error [${error.kind}]: ${error.message}`,
      ...(error.serverCode ? [`Server code: ${error.serverCode}`] : []),
      ...(error.requestId ? [`Request ID: ${error.requestId}`] : []),
      ...Object.entries(error.details).map(([key, value]) => `${key}: ${value}`),
    ];
  }
  if (error instanceof SignedTokenError) return [`Signed credential error [${error.code}]: ${error.message}`];
  return [error instanceof Error ? error.message : String(error)];
}
