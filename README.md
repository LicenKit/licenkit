# LicenKit

**English** | [简体中文](./README.zh-CN.md)

LicenKit is a self-hosted software licensing system for independent developers and small software teams. It provides license key issuance, device activation, online validation, signed license tokens, customer self-service, and notifications. Its infrastructure is built on Cloudflare.

## Features

- Manage products, license plans, licenses, and device activations.
- Support perpetual, fixed-term, and subscription licenses.
- Offer perpetual access to all versions, or to versions released within a configured update period.
- Process payment webhooks for initial license issuance, renewals, suspension, and cancellation, without applying the same event more than once.
- Validate devices online using activation IDs and device fingerprints.
- Optionally issue Ed25519 signed license tokens so clients can verify a snapshot of their license locally, including while offline.
- Provide customer self-service APIs using magic links (email sign-in links) and customer sessions to view licenses, free device seats, and open the payment platform's subscription management page.
- Send initial license keys, key recovery emails, security reset emails, customer magic links, and member invitations through the instance's email integration.
- Record incoming payment events, email delivery status, retry counts, and audit history for troubleshooting and recovery.
- Support multi-tenancy by design.

## Core workflow

For example, when a user enters a license key to activate an app:

1. When a product is created, the server automatically generates an Ed25519 signing key pair. The private key signs licenses, and the public key checks that they are authentic.
2. The developer bundles the public key with the app; the private key is stored encrypted on the server.
3. After a successful activation in `signed` mode, the server signs information such as the license validity period, available features, device identifier, and app version with the private key, then sends it to the app.
4. The app uses its bundled public key to verify the signature and checks the device, version, and validity period. Changing the expiration date or features in the license causes signature verification to fail.
5. The `opaque` mode uses a traditional online ID-based model without client-side signature verification.

## Storage encryption

Signing private keys, credentials for payment and email services, some email content, and similar sensitive data are encrypted with AES-256-GCM before being stored in the database. The server decrypts this data using `STORAGE_ENCRYPTION_KEY`, configured as a Cloudflare Secret during deployment, to issue licenses, send emails, and perform similar operations.

Encryption is bound to the owning instance, record, and field. Moving encrypted data from one record to another prevents it from being decrypted correctly. This protects these sensitive fields; it does not encrypt the entire database.

## How it works

```text
Payment platform webhook
        │
        ▼
Inbound event ──> Purchase fulfillment ──> License / Subscription
                                              │
                                              ├──> Activation / Validation / Signed License Token
                                              ├──> Customer API / Device Management
                                              │
                                              └──> Delivery ──> Email Provider ──> Email service
```

Incoming events and delivery records stored in the database are the source of truth for asynchronous work. Immediate processing after a request reduces latency, while a scheduled Worker scans for pending work, retries failures, and recovers interrupted processing. The current architecture does not depend on Cloudflare Queues.

A User is a sign-in identity; an Instance is a business tenant; a Membership stores the user's role and access status within that instance; and an Invitation lets a user join an instance. Self-hosted installations expose a single instance, while database records and server queries remain isolated by `instance_id`. The current interface does not offer creation of, or switching to, a second instance.

## Repository structure

```text
apps/server             Hono + Cloudflare Workers API
apps/admin              React admin console
apps/cli                Command-line client
wrangler.jsonc          Cloudflare Worker configuration for the current instance
docs                    User guides, maintainer references, and development records
```

The Swift SDK lives in a separate sibling repository, `licenkit-sdk-swift`.

## Technology stack

- Cloudflare Workers, D1, and Scheduled Triggers.
- Hono, Drizzle ORM, and TypeScript.
- React and Vite.
- The Swift SDK uses Foundation, CryptoKit, Security, and IOKit.

## Local development

```bash
pnpm install
pnpm dev
```

Common checks:

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Deployment and site responsibilities

A production LicenKit deployment includes the Worker API, scheduled processing, and the `/admin` console. The root path redirects to `/admin/`. Product websites, purchase result pages, magic link pages, and customer portals are implemented by the integrator; LicenKit does not provide those pages or keep example frontend source for them in this repository.

Setup stores `admin_api_url` and `customer_site_url` for each instance. `admin_api_url` is the public origin (scheme, host, and port) of the LicenKit admin console and API. The setup page defaults to the current Worker's origin, and the server requires an exact match. `customer_site_url` is the base URL of your website and customer portal, used to generate magic links in emails. The two URLs may have different origins, but must use the same scheme and registrable domain to support `SameSite=Lax` customer cookies. Customer CORS, which controls cross-origin browser access, identifies the instance from the `admin_api_url` receiving the request and allows only that instance's `customer_site_url` origin, rather than using global Wrangler variables. Production environments and regular domains require HTTPS. HTTP is allowed only for local development on `localhost` or `127.0.0.1` in an explicitly non-production environment. For self-hosting, bind the admin/API domain to the corresponding Worker; the interface does not display CNAME or managed certificate settings.

The root `wrangler.jsonc` is the sole source of Worker configuration for the current deployment. Wrangler is a direct dependency of the root package because it handles development, migrations, builds, and deployment for LicenKit as a whole. `apps/server` contains only Worker server source and its tests. Set database IDs, variables, and environments directly in the root configuration; configuration is not selected or merged from other directories. Workers Observability is explicitly enabled in the root configuration. Remote acceptance checks must also confirm actual scheduled executions in Cloudflare Cron Events and Workers Logs.

`dist` contains only the LicenKit admin deployment assets. See the [Customer Site integration checklist (Simplified Chinese)](./docs/zh-CN/customer-site-integration.md) for the pages you need to implement, customer APIs, and security requirements.

Test and production environments use the same modules and flows, with configuration changes for resource URLs, secrets, and payment platform environments.

## Documentation

Start with the [documentation index (Simplified Chinese)](./docs/README.md). The user guides are currently available in Simplified Chinese.

## License and contributions

Original LicenKit code and documentation in this repository are licensed under the **GNU Affero General Public License, version 3 only**, identified as `AGPL-3.0-only`. See [LICENSE](./LICENSE) for the full terms. The project has not selected "version 3 or any later version"; the application example in the license's appendix does not change this choice. Copyright holders retain their respective copyrights.

The AGPL permits commercial use, subject to its applicable terms when using, modifying, distributing, or providing modified versions over a network. See section 13 for source availability requirements for network interaction. This license notice does not grant a separate proprietary or commercial license.

Third-party dependencies, assets, licenses, and copyright notices remain subject to their own terms, which are not changed by this repository's license choice. [CLA.md](./CLA.md) is adapted from a Harmony template, and its text is provided under CC BY 3.0 as stated in that file. Permission to reuse the agreement's text is separate from the rights contributors grant to the project. This notice does not replace ownership checks for existing contributions or retroactively obtain additional rights from other rights holders.

See [CONTRIBUTING.md (Simplified Chinese)](./CONTRIBUTING.md) for the contribution process. **By submitting a PR for inclusion in this repository, you agree to the English terms of the [LicenKit CLA v1.0](./CLA.md) and license the contributions in that PR that you have authority to license under that agreement.** Read the full agreement before submitting. The English terms are the sole binding text; translations and explanations in other languages are for reference only. You retain copyright while granting the recipient **commercial, proprietary, and multi-tier sublicensing rights**. The agreement permits lawful transfer with the project or a related business, including an acquisition, provided the transferee **assumes the agreement's obligations in writing**; existing public-license rights remain in place. The initial recipient is the holder of the GitHub account identified in the CLA. This rule applies to new PRs submitted after the agreement and its submission notice have been published; it does not automatically cover earlier contributions or other rights holders' rights.
