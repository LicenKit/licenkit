PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_product_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`product_id` text NOT NULL,
	`version` text NOT NULL,
	`platform` text NOT NULL,
	`arch` text NOT NULL,
	`description` text,
	`download_url` text,
	`artifact_sha256` text NOT NULL,
	`released_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`instance_id`,`product_id`) REFERENCES `products`(`instance_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_product_releases_platform" CHECK("__new_product_releases"."platform" in ('macos', 'windows', 'linux')),
	CONSTRAINT "ck_product_releases_arch" CHECK("__new_product_releases"."arch" in ('universal', 'arm64', 'x86_64')),
	CONSTRAINT "ck_product_releases_artifact_sha256" CHECK(length("__new_product_releases"."artifact_sha256") = 64
        and "__new_product_releases"."artifact_sha256" = lower("__new_product_releases"."artifact_sha256")
        and "__new_product_releases"."artifact_sha256" not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
INSERT INTO `__new_product_releases`(
	"id", "instance_id", "product_id", "version", "platform", "arch",
	"description", "download_url", "artifact_sha256", "released_at", "created_at", "updated_at"
)
SELECT
	"id",
	"instance_id",
	"product_id",
	"version",
	CASE "platform"
		WHEN 'macos-universal' THEN 'macos'
		WHEN 'macos-arm64' THEN 'macos'
		WHEN 'macos-x86_64' THEN 'macos'
		WHEN 'windows-universal' THEN 'windows'
		WHEN 'windows-arm64' THEN 'windows'
		WHEN 'windows-x86_64' THEN 'windows'
		WHEN 'linux-universal' THEN 'linux'
		WHEN 'linux-arm64' THEN 'linux'
		WHEN 'linux-x86_64' THEN 'linux'
	END,
	CASE "platform"
		WHEN 'macos-universal' THEN 'universal'
		WHEN 'macos-arm64' THEN 'arm64'
		WHEN 'macos-x86_64' THEN 'x86_64'
		WHEN 'windows-universal' THEN 'universal'
		WHEN 'windows-arm64' THEN 'arm64'
		WHEN 'windows-x86_64' THEN 'x86_64'
		WHEN 'linux-universal' THEN 'universal'
		WHEN 'linux-arm64' THEN 'arm64'
		WHEN 'linux-x86_64' THEN 'x86_64'
	END,
	"description",
	"download_url",
	"artifact_sha256",
	"released_at",
	"created_at",
	"updated_at"
FROM `product_releases`;--> statement-breakpoint
DROP TABLE `product_releases`;--> statement-breakpoint
ALTER TABLE `__new_product_releases` RENAME TO `product_releases`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_product_releases_lookup` ON `product_releases` (`instance_id`,`product_id`,`version`,`platform`,`arch`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_product_releases_instance_id` ON `product_releases` (`instance_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_product_releases_identity` ON `product_releases` (`product_id`,`version`,`platform`,`arch`);--> statement-breakpoint
CREATE TRIGGER trg_product_releases_immutable_identity
BEFORE UPDATE OF id, instance_id, product_id, version, platform, arch, artifact_sha256, released_at
ON product_releases
WHEN NEW.id IS NOT OLD.id
  OR NEW.instance_id IS NOT OLD.instance_id
  OR NEW.product_id IS NOT OLD.product_id
  OR NEW.version IS NOT OLD.version
  OR NEW.platform IS NOT OLD.platform
  OR NEW.arch IS NOT OLD.arch
  OR NEW.artifact_sha256 IS NOT OLD.artifact_sha256
  OR NEW.released_at IS NOT OLD.released_at
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_RELEASE_IDENTITY_IMMUTABLE');
END;--> statement-breakpoint
CREATE TRIGGER trg_product_releases_prevent_delete
BEFORE DELETE ON product_releases
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_RELEASE_DELETE_FORBIDDEN');
END;
