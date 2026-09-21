import type { AdminSession } from "./api-client";

export interface InvitationAcceptanceApi {
  acceptCurrentSession: (token: string) => Promise<AdminSession>;
  acceptExistingUser: (body: { token: string; email: string; password: string }) => Promise<AdminSession>;
}

export function acceptInvitationForExistingUser(input: {
  api: InvitationAcceptanceApi;
  token: string;
  currentSession: AdminSession | null;
  email: string;
  password: string;
}): Promise<AdminSession> {
  if (input.currentSession) return input.api.acceptCurrentSession(input.token);
  return input.api.acceptExistingUser({ token: input.token, email: input.email, password: input.password });
}
