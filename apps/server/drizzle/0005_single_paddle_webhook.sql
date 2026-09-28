-- A unified Paddle destination uses the existing business Webhook Secret.
-- Prior Simulator-only evidence must be repeated through the unified destination.
UPDATE billing_providers
SET simulator_webhook_secret_ciphertext = NULL,
    simulator_webhook_secret_version = simulator_webhook_secret_version + 1
WHERE provider = 'paddle';
