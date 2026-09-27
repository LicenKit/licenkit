import { ulid } from "ulid";
import type { InstanceRole } from "../../types";
import { hashPassword, verifyPassword } from "../../infra/crypto";
import { AppError, ConflictError, NotFoundError, UnauthorizedError } from "../../middleware/error";
import { prepareEmailNotificationDelivery } from "../delivery/outbox";
import { prepareAuditInsert } from "./audit";
import {
  createSessionSecrets,
  positiveIntegerSetting,
} from "./session";
import {
  hashOneTimeLinkToken,
  prepareOneTimeLink,
} from "./one-time-link";

const INVITATION_NOTIFICATION_TYPE = "instance.member_invited";
const INVITATION_CONTRACT_VERSION = 1;
const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface InvitationRequestContext {
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface InvitationRow {
  id: string;
  instance_id: string;
  email: string;
  role: InstanceRole;
  status: "pending" | "accepted" | "revoked" | "expired";
  invited_by_user_id: string;
  accepted_by_user_id: string | null;
  delivery_id: string;
  delivery_status: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvitationResponse {
  id: string;
  instance_id: string;
  email: string;
  role: InstanceRole;
  status: "pending" | "accepted" | "revoked" | "expired";
  invited_by_user_id: string;
  accepted_by_user_id: string | null;
  delivery: { id: string; status: string };
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AcceptedInvitationSession {
  user: { id: string; email: string; name: string };
  instance: {
    id: string;
    name: string;
    customer_site_url: string;
    admin_api_url: string;
    status: string;
  };
  membership: {
    role: InstanceRole;
    status: "active";
  };
  expires_at?: string;
}

export type InvitationAcceptanceMode =
  | { kind: "session"; userId: string; userEmail: string; sessionId: string }
  | { kind: "existing_user"; email: string; password: string }
  | { kind: "new_user"; name: string; password: string };

export interface InvitationAcceptanceResult {
  session: AcceptedInvitationSession;
  cookies?: {
    sessionToken: string;
    csrfToken: string;
    maxAge: number;
  };
}

interface InstanceRow {
  id: string;
  name: string;
  site_url: string;
  admin_api_url: string;
  status: string;
}

interface MembershipRow {
  role: InstanceRole;
  status: "active" | "disabled" | "removed";
}

interface AcceptanceCandidateRow extends InstanceRow {
  invitation_id: string;
  invitation_email: string;
  invitation_role: InstanceRole;
  delivery_id: string;
}

interface UserIdentityRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function response(row: InvitationRow, nowIso?: string): InvitationResponse {
  const status = row.status === "pending" && nowIso && row.expires_at <= nowIso
    ? "expired"
    : row.status;
  return {
    id: row.id,
    instance_id: row.instance_id,
    email: row.email,
    role: row.role,
    status,
    invited_by_user_id: row.invited_by_user_id,
    accepted_by_user_id: row.accepted_by_user_id,
    delivery: { id: row.delivery_id, status: row.delivery_status },
    expires_at: row.expires_at,
    accepted_at: row.accepted_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function readInstance(db: D1Database, instanceId: string): Promise<InstanceRow> {
  const result = await db
    .prepare(
      `SELECT id, name, site_url, admin_api_url, status
       FROM instances WHERE id = ?1 AND status = 'active' LIMIT 1`,
    )
    .bind(instanceId)
    .all<InstanceRow>();
  const instance = result.results[0];
  if (!instance) throw new NotFoundError("Active Instance not found");
  return instance;
}

async function readInvitation(
  db: D1Database,
  instanceId: string,
  invitationId: string,
): Promise<InvitationRow | undefined> {
  const result = await db
    .prepare(
      `SELECT invitation.id, invitation.instance_id, invitation.email,
              invitation.role, invitation.status, invitation.invited_by_user_id,
              invitation.accepted_by_user_id, invitation.delivery_id,
              delivery.status AS delivery_status, invitation.expires_at,
              invitation.accepted_at, invitation.revoked_at,
              invitation.created_at, invitation.updated_at
       FROM instance_invitations AS invitation
       JOIN email_deliveries AS delivery
         ON delivery.instance_id = invitation.instance_id
        AND delivery.id = invitation.delivery_id
       WHERE invitation.instance_id = ?1 AND invitation.id = ?2
       LIMIT 1`,
    )
    .bind(instanceId, invitationId)
    .all<InvitationRow>();
  return result.results[0];
}

function databaseErrorDetails(error: unknown): {
  database_error: string;
} {
  return { database_error: error instanceof Error ? error.message : String(error) };
}

function invitationDatabaseFailure(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): AppError {
  const details = databaseErrorDetails(error);
  const original = details.database_error;
  if (original.includes("INSTANCE_INVITATION_ALREADY_FINALIZED")) {
    return new AppError(
      "INSTANCE_INVITATION_ALREADY_FINALIZED",
      "The Invitation has already reached a terminal state",
      409,
      details,
      details,
    );
  }
  if (original.includes("INSTANCE_INVITATION_EXPIRED")) {
    return new AppError(
      "INSTANCE_INVITATION_EXPIRED",
      "The Invitation has expired",
      409,
      details,
      details,
    );
  }
  if (original.includes("LAST_ACTIVE_OWNER_REQUIRED")) {
    return new AppError(
      "LAST_ACTIVE_OWNER_REQUIRED",
      "The last active Owner cannot be changed",
      409,
      details,
      details,
    );
  }
  if (original.includes("uq_instance_invitations_pending_email") ||
      original.includes("instance_invitations.instance_id, instance_invitations.email")) {
    return new ConflictError(
      "INSTANCE_INVITATION_ALREADY_PENDING",
      "A pending Invitation already exists for this email",
    );
  }
  if (original.includes("users.email") || original.includes("uq_users_email")) {
    return new AppError(
      "INSTANCE_INVITATION_EXISTING_USER_REQUIRED",
      "This Invitation email already belongs to an existing User",
      409,
      details,
      details,
    );
  }
  return new AppError(
    fallbackCode,
    fallbackMessage,
    500,
    details,
    details,
  );
}

function finishDeliveryStatement(input: {
  db: D1Database;
  instanceId: string;
  deliveryId: string;
  terminalStatus: "cancelled" | "expired";
  now: string;
}): D1PreparedStatement {
  return input.db
    .prepare(
      `UPDATE email_deliveries
       SET send_expires_at = CASE WHEN status = 'accepted' THEN send_expires_at ELSE ?1 END,
           status = CASE WHEN status = 'accepted' THEN status ELSE ?2 END,
           variables_ciphertext = CASE WHEN status = 'accepted' THEN variables_ciphertext ELSE NULL END,
           next_attempt_at = NULL,
           locked_by = NULL,
           locked_until = NULL,
           updated_at = ?1
       WHERE instance_id = ?3 AND id = ?4`,
    )
    .bind(input.now, input.terminalStatus, input.instanceId, input.deliveryId);
}

async function prepareInvitationRecord(input: {
  db: D1Database;
  env: { STORAGE_ENCRYPTION_KEY?: string; ENVIRONMENT?: string };
  instance: InstanceRow;
  adminOrigin: string;
  email: string;
  role: InstanceRole;
  invitedByUserId: string;
  now: Date;
}) {
  const invitationId = `ivi_${ulid().toLowerCase()}`;
  const expiresAt = new Date(
    input.now.getTime() + INVITATION_TTL_SECONDS * 1000,
  ).toISOString();
  const link = await prepareOneTimeLink({
    tokenPrefix: "ivk",
    trustedUrl: input.adminOrigin,
    path: "/admin/invitations/accept",
    environment: input.env.ENVIRONMENT,
  });
  const delivery = await prepareEmailNotificationDelivery({
    db: input.db,
    env: input.env,
    instanceId: input.instance.id,
    recipientType: "instance_invitation",
    notificationType: INVITATION_NOTIFICATION_TYPE,
    contractVersion: INVITATION_CONTRACT_VERSION,
    recipientEmail: input.email,
    trustedAdminOrigin: input.adminOrigin,
    variables: {
      invitation_url: link.url,
      expires_at: expiresAt,
    },
    sendExpiresAt: expiresAt,
    now: input.now,
  });
  const statement = input.db
    .prepare(
      `INSERT INTO instance_invitations (
         id, instance_id, email, role, token_hash, status,
         invited_by_user_id, delivery_id, expires_at, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?9, ?9)`,
    )
    .bind(
      invitationId,
      input.instance.id,
      input.email,
      input.role,
      link.tokenHash,
      input.invitedByUserId,
      delivery.deliveryId,
      expiresAt,
      input.now.toISOString(),
    );
  return { invitationId, expiresAt, delivery, statement };
}

async function assertInvitationTargetCanJoin(
  db: D1Database,
  instanceId: string,
  email: string,
): Promise<void> {
  const result = await db
    .prepare(
      `SELECT membership.status
       FROM users AS user
       JOIN instance_memberships AS membership
         ON membership.user_id = user.id
        AND membership.instance_id = ?1
       WHERE user.email = ?2 COLLATE NOCASE
       LIMIT 1`,
    )
    .bind(instanceId, email)
    .all<{ status: "active" | "disabled" | "removed" }>();
  const membership = result.results[0];
  if (membership && membership.status !== "removed") {
    throw new ConflictError(
      "INSTANCE_MEMBERSHIP_ALREADY_EXISTS",
      membership.status === "disabled"
        ? "The existing disabled Membership must be restored instead of reinvited"
        : "The User is already an active member of this Instance",
    );
  }
}

export async function listInstanceInvitations(input: {
  db: D1Database;
  instanceId: string;
}): Promise<InvitationResponse[]> {
  const nowIso = new Date().toISOString();
  const result = await input.db
    .prepare(
      `SELECT invitation.id, invitation.instance_id, invitation.email,
              invitation.role, invitation.status, invitation.invited_by_user_id,
              invitation.accepted_by_user_id, invitation.delivery_id,
              delivery.status AS delivery_status, invitation.expires_at,
              invitation.accepted_at, invitation.revoked_at,
              invitation.created_at, invitation.updated_at
       FROM instance_invitations AS invitation
       JOIN email_deliveries AS delivery
         ON delivery.instance_id = invitation.instance_id
        AND delivery.id = invitation.delivery_id
       WHERE invitation.instance_id = ?1
       ORDER BY invitation.created_at DESC, invitation.id DESC`,
    )
    .bind(input.instanceId)
    .all<InvitationRow>();
  return result.results.map((row) => response(row, nowIso));
}

export async function createInstanceInvitation(input: {
  db: D1Database;
  env: { STORAGE_ENCRYPTION_KEY?: string; ENVIRONMENT?: string };
  instanceId: string;
  actorUserId: string;
  email: string;
  role: InstanceRole;
  request: InvitationRequestContext;
}): Promise<InvitationResponse> {
  const email = normalizeEmail(input.email);
  await assertInvitationTargetCanJoin(input.db, input.instanceId, email);
  const instance = await readInstance(input.db, input.instanceId);
  const now = new Date();
  const nowIso = now.toISOString();
  const pendingResult = await input.db
    .prepare(
      `SELECT id, delivery_id, expires_at
       FROM instance_invitations
       WHERE instance_id = ?1 AND email = ?2 COLLATE NOCASE AND status = 'pending'
       LIMIT 1`,
    )
    .bind(input.instanceId, email)
    .all<{ id: string; delivery_id: string; expires_at: string }>();
  const pending = pendingResult.results[0];
  if (pending && pending.expires_at > nowIso) {
    throw new ConflictError(
      "INSTANCE_INVITATION_ALREADY_PENDING",
      "A pending Invitation already exists for this email",
    );
  }
  const prepared = await prepareInvitationRecord({
    db: input.db,
    env: input.env,
    instance,
    adminOrigin: instance.admin_api_url,
    email,
    role: input.role,
    invitedByUserId: input.actorUserId,
    now,
  });
  const statements: D1PreparedStatement[] = [];
  if (pending) {
    statements.push(
      input.db
        .prepare(
          `UPDATE instance_invitations
           SET status = 'expired', updated_at = ?1
           WHERE instance_id = ?2 AND id = ?3`,
        )
        .bind(nowIso, input.instanceId, pending.id),
      finishDeliveryStatement({
        db: input.db,
        instanceId: input.instanceId,
        deliveryId: pending.delivery_id,
        terminalStatus: "expired",
        now: nowIso,
      }),
    );
  }
  statements.push(
    ...prepared.delivery.statements,
    prepared.statement,
    prepareAuditInsert({
      db: input.db,
      instanceId: input.instanceId,
      actor: { type: "user", id: input.actorUserId },
      action: "instance.invitation.created",
      resourceType: "instance_invitation",
      resourceId: prepared.invitationId,
      details: {
        email,
        role: input.role,
        delivery_id: prepared.delivery.deliveryId,
        delivery_status: prepared.delivery.status,
        expires_at: prepared.expiresAt,
      },
      requestId: input.request.requestId,
      ip: input.request.ip,
      userAgent: input.request.userAgent,
      now: nowIso,
    }),
  );
  try {
    await input.db.batch(statements);
  } catch (error) {
    throw invitationDatabaseFailure(
      error,
      "INSTANCE_INVITATION_CREATE_FAILED",
      "The Invitation could not be created",
    );
  }
  const created = await readInvitation(input.db, input.instanceId, prepared.invitationId);
  if (!created) throw new NotFoundError("Created Invitation not found");
  return response(created);
}

export async function revokeInstanceInvitation(input: {
  db: D1Database;
  instanceId: string;
  invitationId: string;
  actorUserId: string;
  request: InvitationRequestContext;
}): Promise<InvitationResponse> {
  const current = await readInvitation(input.db, input.instanceId, input.invitationId);
  if (!current) throw new NotFoundError("Invitation not found");
  const now = new Date().toISOString();
  try {
    await input.db.batch([
      input.db
        .prepare(
          `UPDATE instance_invitations
           SET status = 'revoked', revoked_at = ?1, updated_at = ?1
           WHERE instance_id = ?2 AND id = ?3`,
        )
        .bind(now, input.instanceId, input.invitationId),
      finishDeliveryStatement({
        db: input.db,
        instanceId: input.instanceId,
        deliveryId: current.delivery_id,
        terminalStatus: "cancelled",
        now,
      }),
      prepareAuditInsert({
        db: input.db,
        instanceId: input.instanceId,
        actor: { type: "user", id: input.actorUserId },
        action: "instance.invitation.revoked",
        resourceType: "instance_invitation",
        resourceId: input.invitationId,
        details: { email: current.email, role: current.role },
        requestId: input.request.requestId,
        ip: input.request.ip,
        userAgent: input.request.userAgent,
        now,
      }),
    ]);
  } catch (error) {
    throw invitationDatabaseFailure(
      error,
      "INSTANCE_INVITATION_REVOKE_FAILED",
      "The Invitation could not be revoked",
    );
  }
  const revoked = await readInvitation(input.db, input.instanceId, input.invitationId);
  if (!revoked) throw new NotFoundError("Invitation not found");
  return response(revoked);
}

export async function resendInstanceInvitation(input: {
  db: D1Database;
  env: { STORAGE_ENCRYPTION_KEY?: string; ENVIRONMENT?: string };
  instanceId: string;
  invitationId: string;
  actorUserId: string;
  request: InvitationRequestContext;
}): Promise<InvitationResponse> {
  const current = await readInvitation(input.db, input.instanceId, input.invitationId);
  if (!current) throw new NotFoundError("Invitation not found");
  const instance = await readInstance(input.db, input.instanceId);
  const now = new Date();
  const nowIso = now.toISOString();
  const prepared = await prepareInvitationRecord({
    db: input.db,
    env: input.env,
    instance,
    adminOrigin: instance.admin_api_url,
    email: current.email,
    role: current.role,
    invitedByUserId: input.actorUserId,
    now,
  });
  try {
    await input.db.batch([
      input.db
        .prepare(
          `UPDATE instance_invitations
           SET status = 'revoked', revoked_at = ?1, updated_at = ?1
           WHERE instance_id = ?2 AND id = ?3`,
        )
        .bind(nowIso, input.instanceId, input.invitationId),
      finishDeliveryStatement({
        db: input.db,
        instanceId: input.instanceId,
        deliveryId: current.delivery_id,
        terminalStatus: "cancelled",
        now: nowIso,
      }),
      ...prepared.delivery.statements,
      prepared.statement,
      prepareAuditInsert({
        db: input.db,
        instanceId: input.instanceId,
        actor: { type: "user", id: input.actorUserId },
        action: "instance.invitation.resent",
        resourceType: "instance_invitation",
        resourceId: prepared.invitationId,
        details: {
          supersedes_invitation_id: input.invitationId,
          email: current.email,
          role: current.role,
          delivery_id: prepared.delivery.deliveryId,
          delivery_status: prepared.delivery.status,
        },
        requestId: input.request.requestId,
        ip: input.request.ip,
        userAgent: input.request.userAgent,
        now: nowIso,
      }),
    ]);
  } catch (error) {
    throw invitationDatabaseFailure(
      error,
      "INSTANCE_INVITATION_RESEND_FAILED",
      "The Invitation could not be resent",
    );
  }
  const resent = await readInvitation(input.db, input.instanceId, prepared.invitationId);
  if (!resent) throw new NotFoundError("Resent Invitation not found");
  return response(resent);
}

async function readAcceptanceCandidate(
  db: D1Database,
  tokenHash: string,
  now: string,
): Promise<AcceptanceCandidateRow | undefined> {
  const result = await db
    .prepare(
      `SELECT invitation.id AS invitation_id,
              invitation.email AS invitation_email,
              invitation.role AS invitation_role,
              invitation.delivery_id,
              instance.id, instance.name, instance.site_url,
              instance.admin_api_url, instance.status
       FROM instance_invitations AS invitation
       JOIN instances AS instance
         ON instance.id = invitation.instance_id AND instance.status = 'active'
       WHERE invitation.token_hash = ?1
         AND invitation.status = 'pending'
         AND invitation.expires_at > ?2
       LIMIT 1`,
    )
    .bind(tokenHash, now)
    .all<AcceptanceCandidateRow>();
  return result.results[0];
}

async function readMembership(
  db: D1Database,
  instanceId: string,
  userId: string,
): Promise<MembershipRow | undefined> {
  const result = await db
    .prepare(
      `SELECT role, status
       FROM instance_memberships
       WHERE instance_id = ?1 AND user_id = ?2
       LIMIT 1`,
    )
    .bind(instanceId, userId)
    .all<MembershipRow>();
  return result.results[0];
}

function membershipAcceptanceStatement(input: {
  db: D1Database;
  membership: MembershipRow | undefined;
  instanceId: string;
  userId: string;
  role: InstanceRole;
  invitationId: string;
  now: string;
}): D1PreparedStatement {
  if (input.membership?.status === "active") {
    throw new ConflictError(
      "INSTANCE_MEMBERSHIP_ALREADY_ACTIVE",
      "The User is already an active member of this Instance",
    );
  }
  if (input.membership?.status === "disabled") {
    throw new ConflictError(
      "INSTANCE_MEMBERSHIP_DISABLED",
      "A disabled Membership must be restored by an active Owner",
    );
  }
  if (input.membership?.status === "removed") {
    return input.db
      .prepare(
        `UPDATE instance_memberships
         SET role = ?1, status = 'active', joined_by_invitation_id = ?2, updated_at = ?3
         WHERE instance_id = ?4 AND user_id = ?5`,
      )
      .bind(
        input.role,
        input.invitationId,
        input.now,
        input.instanceId,
        input.userId,
      );
  }
  return input.db
    .prepare(
      `INSERT INTO instance_memberships (
         instance_id, user_id, role, status, joined_by_invitation_id, created_at, updated_at
       ) VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?5)`,
    )
    .bind(
      input.instanceId,
      input.userId,
      input.role,
      input.invitationId,
      input.now,
    );
}

export async function acceptInstanceInvitation(input: {
  db: D1Database;
  env: { ADMIN_SESSION_TTL_SECONDS?: string };
  token: string;
  mode: InvitationAcceptanceMode;
  request: InvitationRequestContext;
}): Promise<InvitationAcceptanceResult> {
  const now = new Date();
  const nowIso = now.toISOString();
  const tokenHash = await hashOneTimeLinkToken(input.token);
  const candidate = await readAcceptanceCandidate(input.db, tokenHash, nowIso);
  if (!candidate) {
    throw new AppError(
      "INSTANCE_INVITATION_INVALID",
      "The Invitation is invalid or expired",
      400,
    );
  }

  let user: UserIdentityRow;
  let passwordHash: string | undefined;
  if (input.mode.kind === "session") {
    if (normalizeEmail(input.mode.userEmail) !== normalizeEmail(candidate.invitation_email)) {
      throw new AppError(
        "INSTANCE_INVITATION_IDENTITY_MISMATCH",
        "The signed-in User does not match the Invitation email",
        403,
      );
    }
    const result = await input.db
      .prepare(`SELECT id, email, name, password_hash FROM users WHERE id = ?1 LIMIT 1`)
      .bind(input.mode.userId)
      .all<UserIdentityRow>();
    const found = result.results[0];
    if (!found) throw new UnauthorizedError();
    user = found;
  } else if (input.mode.kind === "existing_user") {
    const email = normalizeEmail(input.mode.email);
    if (email !== normalizeEmail(candidate.invitation_email)) {
      throw new UnauthorizedError("Invalid Invitation identity credentials");
    }
    const result = await input.db
      .prepare(`SELECT id, email, name, password_hash FROM users WHERE email = ?1 COLLATE NOCASE LIMIT 1`)
      .bind(email)
      .all<UserIdentityRow>();
    const found = result.results[0];
    if (!found || !(await verifyPassword(input.mode.password, found.password_hash))) {
      throw new UnauthorizedError("Invalid Invitation identity credentials");
    }
    user = found;
  } else {
    const existing = await input.db
      .prepare(`SELECT id FROM users WHERE email = ?1 COLLATE NOCASE LIMIT 1`)
      .bind(candidate.invitation_email)
      .all<{ id: string }>();
    if (existing.results[0]) {
      throw new AppError(
        "INSTANCE_INVITATION_EXISTING_USER_REQUIRED",
        "This Invitation belongs to an existing User; verify that User's credentials",
        409,
      );
    }
    passwordHash = await hashPassword(input.mode.password);
    user = {
      id: `usr_${ulid().toLowerCase()}`,
      email: normalizeEmail(candidate.invitation_email),
      name: input.mode.name,
      password_hash: passwordHash,
    };
  }

  const membership = await readMembership(input.db, candidate.id, user.id);
  const membershipStatement = membershipAcceptanceStatement({
    db: input.db,
    membership,
    instanceId: candidate.id,
    userId: user.id,
    role: candidate.invitation_role,
    invitationId: candidate.invitation_id,
    now: nowIso,
  });

  const needsSession = input.mode.kind !== "session";
  const ttlSeconds = positiveIntegerSetting(
    input.env.ADMIN_SESSION_TTL_SECONDS,
    604_800,
    "ADMIN_SESSION_TTL_SECONDS",
  );
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const sessionId = input.mode.kind === "session"
    ? input.mode.sessionId
    : `ase_${ulid().toLowerCase()}`;
  const secrets = needsSession ? await createSessionSecrets("adm") : undefined;
  const statements: D1PreparedStatement[] = [];
  if (passwordHash) {
    statements.push(
      input.db
        .prepare(
          `INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
        )
        .bind(user.id, user.email, passwordHash, user.name, nowIso),
    );
  }
  statements.push(membershipStatement);
  if (needsSession && secrets) {
    statements.push(
      input.db
        .prepare(
          `INSERT INTO admin_sessions (
             id, user_id, session_token_hash, csrf_token_hash, expires_at, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(
          sessionId,
          user.id,
          secrets.sessionTokenHash,
          secrets.csrfTokenHash,
          expiresAt,
          nowIso,
        ),
    );
  }
  statements.push(
    input.db
      .prepare(
        `UPDATE instance_invitations
         SET status = 'accepted', accepted_by_user_id = ?1,
             accepted_at = ?2, updated_at = ?2
         WHERE instance_id = ?3 AND id = ?4`,
      )
      .bind(user.id, nowIso, candidate.id, candidate.invitation_id),
    finishDeliveryStatement({
      db: input.db,
      instanceId: candidate.id,
      deliveryId: candidate.delivery_id,
      terminalStatus: "cancelled",
      now: nowIso,
    }),
    prepareAuditInsert({
      db: input.db,
      instanceId: candidate.id,
      actor: { type: "user", id: user.id },
      action: "instance.invitation.accepted",
      resourceType: "instance_invitation",
      resourceId: candidate.invitation_id,
      details: {
        role: candidate.invitation_role,
        membership_rejoined: membership?.status === "removed",
      },
      requestId: input.request.requestId,
      ip: input.request.ip,
      userAgent: input.request.userAgent,
      now: nowIso,
    }),
  );
  if (needsSession) {
    statements.push(
      prepareAuditInsert({
        db: input.db,
        scopeType: "identity",
        actor: { type: "user", id: user.id },
        action: "identity.login",
        resourceType: "admin_session",
        resourceId: sessionId,
        details: { source: "instance_invitation" },
        requestId: input.request.requestId,
        ip: input.request.ip,
        userAgent: input.request.userAgent,
        now: nowIso,
      }),
    );
  }
  try {
    await input.db.batch(statements);
  } catch (error) {
    throw invitationDatabaseFailure(
      error,
      "INSTANCE_INVITATION_ACCEPT_FAILED",
      "The Invitation could not be accepted",
    );
  }

  const acceptedSession: AcceptedInvitationSession = {
    user: { id: user.id, email: user.email, name: user.name },
    instance: {
      id: candidate.id,
      name: candidate.name,
      customer_site_url: candidate.site_url,
      admin_api_url: candidate.admin_api_url,
      status: candidate.status,
    },
    membership: { role: candidate.invitation_role, status: "active" },
    ...(needsSession ? { expires_at: expiresAt } : {}),
  };
  return {
    session: acceptedSession,
    ...(needsSession && secrets
      ? {
          cookies: {
            sessionToken: secrets.sessionToken,
            csrfToken: secrets.csrfToken,
            maxAge: ttlSeconds,
          },
        }
      : {}),
  };
}
