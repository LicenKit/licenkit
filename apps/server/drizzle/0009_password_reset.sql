CREATE TABLE `identity_request_limits` (
	`key_hash` text PRIMARY KEY NOT NULL,
	`request_count` integer NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_identity_request_limit_expiry` ON `identity_request_limits` (`expires_at`);--> statement-breakpoint
CREATE TABLE `password_reset_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`password_hash_at_request` text NOT NULL,
	`admin_origin` text NOT NULL,
	`link_ciphertext` text,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`revoked_at` text,
	`send_status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_id` text,
	`locked_until` text,
	`last_error_code` text,
	`provider_message_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_password_reset_send_status" CHECK("password_reset_requests"."send_status" in ('pending', 'processing', 'accepted', 'failed', 'cancelled', 'expired')),
	CONSTRAINT "ck_password_reset_attempts" CHECK("password_reset_requests"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_password_reset_token` ON `password_reset_requests` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_password_reset_user` ON `password_reset_requests` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_password_reset_due` ON `password_reset_requests` (`send_status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_password_reset_expiry` ON `password_reset_requests` (`expires_at`);
--> statement-breakpoint
CREATE TRIGGER password_reset_consume_guard
BEFORE UPDATE OF consumed_at ON password_reset_requests
WHEN NEW.consumed_at IS NOT NULL
BEGIN
  SELECT CASE WHEN OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL
    OR OLD.expires_at <= NEW.consumed_at
    OR NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id AND password_hash = OLD.password_hash_at_request)
    THEN RAISE(ABORT, 'PASSWORD_RESET_LINK_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER password_change_revokes_reset_links
AFTER UPDATE OF password_hash ON users
WHEN OLD.password_hash <> NEW.password_hash
BEGIN
  UPDATE password_reset_requests
  SET revoked_at = NEW.updated_at, link_ciphertext = NULL, password_hash_at_request = '', send_status = 'cancelled'
  WHERE user_id = NEW.id AND consumed_at IS NULL AND revoked_at IS NULL;
END;
