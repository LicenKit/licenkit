CREATE TABLE `user_recovery_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`consumed_at` text,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_recovery_credential_hash` ON `user_recovery_credentials` (`credential_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_recovery_credential_active_user` ON `user_recovery_credentials` (`user_id`) WHERE "user_recovery_credentials"."consumed_at" is null and "user_recovery_credentials"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX `idx_recovery_credential_user` ON `user_recovery_credentials` (`user_id`);
--> statement-breakpoint
CREATE TRIGGER recovery_credential_consume_guard
BEFORE UPDATE OF consumed_at ON user_recovery_credentials
WHEN NEW.consumed_at IS NOT NULL
BEGIN
  SELECT CASE WHEN OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL
    THEN RAISE(ABORT, 'RECOVERY_CREDENTIAL_INVALID') END;
END;
