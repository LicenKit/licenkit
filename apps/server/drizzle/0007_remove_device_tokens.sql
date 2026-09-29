DROP INDEX `idx_activations_token_hash`;--> statement-breakpoint
ALTER TABLE `activations` DROP COLUMN `machine_token_hash`;--> statement-breakpoint
DROP INDEX `uq_trial_claims_token_hash`;--> statement-breakpoint
ALTER TABLE `trial_claims` DROP COLUMN `trial_token_hash`;