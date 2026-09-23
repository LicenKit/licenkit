import { AppError } from "../../middleware/error";

export type DeploymentSetupStatus = "empty" | "completed" | "inconsistent";

export interface DeploymentSetupState {
  status: DeploymentSetupStatus;
  bootstrapCount: number;
  userCount: number;
  instanceCount: number;
  activeInstanceCount: number;
  membershipCount: number;
  activeOwnerCount: number;
  adminSessionCount: number;
  auditLogCount: number;
}

interface DeploymentSetupCountRow {
  bootstrap_count: number;
  user_count: number;
  instance_count: number;
  active_instance_count: number;
  membership_count: number;
  active_owner_count: number;
  admin_session_count: number;
  audit_log_count: number;
}

export async function readDeploymentSetupState(db: D1Database): Promise<DeploymentSetupState> {
  const result = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM deployment_bootstrap) AS bootstrap_count,
       (SELECT COUNT(*) FROM users) AS user_count,
       (SELECT COUNT(*) FROM instances) AS instance_count,
       (SELECT COUNT(*) FROM instances WHERE status = 'active') AS active_instance_count,
       (SELECT COUNT(*) FROM instance_memberships) AS membership_count,
       (SELECT COUNT(*) FROM instance_memberships
        WHERE role = 'owner' AND status = 'active') AS active_owner_count,
       (SELECT COUNT(*) FROM admin_sessions) AS admin_session_count,
       (SELECT COUNT(*) FROM audit_logs) AS audit_log_count`,
  ).all<DeploymentSetupCountRow>();
  const row = result.results[0];
  if (!row) throw new AppError("SETUP_STATE_UNAVAILABLE", "Setup state could not be read", 500);

  const counts = {
    bootstrapCount: Number(row.bootstrap_count),
    userCount: Number(row.user_count),
    instanceCount: Number(row.instance_count),
    activeInstanceCount: Number(row.active_instance_count),
    membershipCount: Number(row.membership_count),
    activeOwnerCount: Number(row.active_owner_count),
    adminSessionCount: Number(row.admin_session_count),
    auditLogCount: Number(row.audit_log_count),
  };
  const empty = Object.values(counts).every((count) => count === 0);
  const completed = counts.bootstrapCount === 1
    && counts.instanceCount === 1
    && counts.activeInstanceCount === 1
    && counts.userCount >= 1
    && counts.membershipCount >= 1
    && counts.activeOwnerCount >= 1;

  return {
    status: empty ? "empty" : completed ? "completed" : "inconsistent",
    ...counts,
  };
}

export interface InitialDeploymentInput {
  db: D1Database;
  user: { id: string; name: string; email: string; passwordHash: string };
  instance: {
    id: string;
    name: string;
    slug: string;
    customerSiteUrl: string;
    adminApiUrl: string;
  };
  session: {
    id: string;
    sessionTokenHash: string;
    csrfTokenHash: string;
    expiresAt: string;
  };
  now: string;
}

export function prepareInitialDeployment(input: InitialDeploymentInput): D1PreparedStatement[] {
  return [
    input.db.prepare(
      `INSERT INTO users (
         id, email, password_hash, name, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    ).bind(
      input.user.id,
      input.user.email,
      input.user.passwordHash,
      input.user.name,
      input.now,
    ),
    input.db.prepare(
      `INSERT INTO instances (
         id, name, slug, site_url, admin_api_url, status, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6)`,
    ).bind(
      input.instance.id,
      input.instance.name,
      input.instance.slug,
      input.instance.customerSiteUrl,
      input.instance.adminApiUrl,
      input.now,
    ),
    input.db.prepare(
      `INSERT INTO instance_memberships (
         instance_id, user_id, role, status, joined_by_invitation_id, created_at, updated_at
       ) VALUES (?1, ?2, 'owner', 'active', NULL, ?3, ?3)`,
    ).bind(input.instance.id, input.user.id, input.now),
    input.db.prepare(
      `INSERT INTO admin_sessions (
         id, user_id, session_token_hash, csrf_token_hash, expires_at, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      input.session.id,
      input.user.id,
      input.session.sessionTokenHash,
      input.session.csrfTokenHash,
      input.session.expiresAt,
      input.now,
    ),
  ];
}
