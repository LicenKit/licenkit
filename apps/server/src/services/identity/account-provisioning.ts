export interface AccountWithOwnerInput {
  db: D1Database;
  account: { id: string; name: string; slug: string };
  owner: { id: string; name: string; email: string; passwordHash: string };
  now: string;
}

/** Internal account provisioning boundary. V1 only exposes it through Setup. */
export function prepareAccountWithOwner(input: AccountWithOwnerInput): D1PreparedStatement[] {
  return [
    input.db
      .prepare(
        `INSERT INTO accounts (
           id, name, slug, default_subscription_payment_grace_seconds,
           status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, 432000, 'active', ?4, ?4)`
      )
      .bind(input.account.id, input.account.name, input.account.slug, input.now),
    input.db
      .prepare(
        `INSERT INTO users (
           id, account_id, email, password_hash, name, role, status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'owner', 'active', ?6, ?6)`
      )
      .bind(
        input.owner.id,
        input.account.id,
        input.owner.email,
        input.owner.passwordHash,
        input.owner.name,
        input.now
      ),
  ];
}

export const AccountProvisioningService = {
  prepareAccountWithOwner,
};

