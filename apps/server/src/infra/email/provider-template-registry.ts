import { AppError } from "../../middleware/error";
import {
  getEmailNotificationContract,
  type EmailVariableValue,
} from "../../domain/email/contracts";

export interface EmailProviderTemplateExample {
  readonly provider: string;
  readonly notificationType: string;
  readonly contractVersion: number;
  readonly fileName: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface EmailProviderTemplateExampleResponse
  extends EmailProviderTemplateExample {
  readonly placeholderSyntax: string;
}

interface EmailProviderTemplateRegistryEntry {
  readonly placeholderSyntax: string;
  readonly examples: Readonly<Record<string, EmailProviderTemplateExample>>;
  readonly validateVariables: (
    variables: Readonly<Record<string, EmailVariableValue>>,
  ) => void;
}

export const RESEND_TEMPLATE_LIMITS = Object.freeze({
  maxVariables: 50,
  maxKeyLength: 50,
  maxStringValueLength: 2000,
  maxNumberValue: Number.MAX_SAFE_INTEGER,
});

export const RESEND_RESERVED_TEMPLATE_VARIABLE_NAMES = Object.freeze([
  "FIRST_NAME",
  "LAST_NAME",
  "EMAIL",
  "UNSUBSCRIBE_URL",
  "RESEND_UNSUBSCRIBE_URL",
  "contact",
  "this",
] as const);

const RESEND_VARIABLE_KEY_PATTERN = /^[A-Za-z0-9_]+$/;
const RESEND_RESERVED_NAMES = new Set<string>(
  RESEND_RESERVED_TEMPLATE_VARIABLE_NAMES,
);

function providerError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: 400 | 404 = 400,
): AppError {
  return new AppError(code, message, status, details);
}

export function validateResendTemplateVariables(
  variables: Readonly<Record<string, EmailVariableValue>>,
): void {
  const entries = Object.entries(variables);
  if (entries.length > RESEND_TEMPLATE_LIMITS.maxVariables) {
    throw providerError(
      "EMAIL_PROVIDER_VARIABLE_COUNT_EXCEEDED",
      "Resend template variables exceed the provider limit.",
      { provider: "resend", maxVariables: RESEND_TEMPLATE_LIMITS.maxVariables },
    );
  }

  for (const [position, [name, value]] of entries.entries()) {
    if (!RESEND_VARIABLE_KEY_PATTERN.test(name)) {
      throw providerError(
        "EMAIL_PROVIDER_VARIABLE_NAME_INVALID",
        "A Resend template variable name contains unsupported characters.",
        { provider: "resend", position, variableCount: entries.length },
      );
    }
    if (name.length > RESEND_TEMPLATE_LIMITS.maxKeyLength) {
      throw providerError(
        "EMAIL_PROVIDER_VARIABLE_NAME_TOO_LONG",
        "A Resend template variable name exceeds the provider limit.",
        {
          provider: "resend",
          position,
          variableCount: entries.length,
          maxLength: RESEND_TEMPLATE_LIMITS.maxKeyLength,
        },
      );
    }
    if (RESEND_RESERVED_NAMES.has(name)) {
      throw providerError(
        "EMAIL_PROVIDER_VARIABLE_NAME_RESERVED",
        "A Resend template variable name is reserved by the provider.",
        { provider: "resend", position, variableCount: entries.length },
      );
    }
    if (
      typeof value === "string" &&
      value.length > RESEND_TEMPLATE_LIMITS.maxStringValueLength
    ) {
      throw providerError(
        "EMAIL_PROVIDER_VARIABLE_STRING_TOO_LONG",
        "A Resend template string variable exceeds the provider limit.",
        {
          provider: "resend",
          position,
          variableCount: entries.length,
          maxLength: RESEND_TEMPLATE_LIMITS.maxStringValueLength,
        },
      );
    }
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw providerError(
        "EMAIL_PROVIDER_VARIABLE_NUMBER_INVALID",
        "A Resend template number variable must be a JavaScript safe integer.",
        {
          provider: "resend",
          position,
          variableCount: entries.length,
          maxAbsoluteValue: RESEND_TEMPLATE_LIMITS.maxNumberValue,
        },
      );
    }
  }
}

function exampleKey(notificationType: string, contractVersion: number): string {
  return `${notificationType}@${contractVersion}`;
}

function example(
  value: EmailProviderTemplateExample,
): EmailProviderTemplateExample {
  return Object.freeze(value);
}

const BASE_RESEND_TEMPLATE_EXAMPLES = Object.freeze([
  example({
    provider: "resend",
    notificationType: "customer.license_issued",
    contractVersion: 1,
    fileName: "customer-license-issued-v1.resend.html",
    subject: "Your {{{product_name}}} license key",
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  </head>
  <body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #18181b; -webkit-font-smoothing: antialiased;">
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f4f4f5; padding: 40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 520px; background-color: #ffffff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 36px 32px; text-align: left; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);">
            <tr>
              <td>
                <div style="font-size: 13px; font-weight: 600; color: #71717a; letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 20px;">{{{instance_name}}}</div>
                <h1 style="margin: 0 0 16px; font-size: 22px; font-weight: 600; line-height: 1.3; color: #09090b; letter-spacing: -0.3px;">Your {{{product_name}}} license</h1>
                <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.6; color: #3f3f46;">Thank you for your purchase. Here is your license key to activate {{{product_name}}}.</p>
                <div style="background-color: #f9fafb; border: 1px solid #e4e4e7; border-radius: 8px; padding: 16px 20px; margin: 0 0 24px;">
                  <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; color: #71717a; margin-bottom: 8px;">License Key</div>
                  <div style="font-family: ui-monospace, 'SFMono-Regular', Menlo, Monaco, Consolas, monospace; font-size: 15px; font-weight: 500; color: #09090b; word-break: break-all; letter-spacing: 0.5px;">{{{license_key}}}</div>
                </div>
                <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 0 0 28px; font-size: 14px; border-top: 1px solid #f4f4f5;">
                  <tr>
                    <td style="padding: 10px 0; color: #71717a; border-bottom: 1px solid #f4f4f5; width: 120px;">Product</td>
                    <td style="padding: 10px 0; color: #09090b; font-weight: 500; border-bottom: 1px solid #f4f4f5;">{{{product_name}}}</td>
                  </tr>
                  <tr>
                    <td style="padding: 10px 0; color: #71717a; border-bottom: 1px solid #f4f4f5;">Model</td>
                    <td style="padding: 10px 0; color: #09090b; font-weight: 500; border-bottom: 1px solid #f4f4f5;">{{{license_model}}}</td>
                  </tr>
                </table>
                <div style="border-top: 1px solid #f4f4f5; padding-top: 20px; font-size: 12px; line-height: 1.5; color: #a1a1aa;">
                  Sent by {{{instance_name}}} &middot; Powered by LicenKit
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
    text: `Your {{{product_name}}} License

Thank you for your purchase. Here is your license key to activate {{{product_name}}}.

License Key:
{{{license_key}}}

Details:
- Product: {{{product_name}}}
- License Model: {{{license_model}}}

---
Sent by {{{instance_name}}} · Powered by LicenKit
`,
  }),
  example({
    provider: "resend",
    notificationType: "customer.license_recovered",
    contractVersion: 1,
    fileName: "customer-license-recovered-v1.resend.html",
    subject: "Your recovered {{{product_name}}} license key",
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  </head>
  <body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #18181b; -webkit-font-smoothing: antialiased;">
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f4f4f5; padding: 40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 520px; background-color: #ffffff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 36px 32px; text-align: left; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);">
            <tr>
              <td>
                <div style="font-size: 13px; font-weight: 600; color: #71717a; letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 20px;">{{{instance_name}}}</div>
                <h1 style="margin: 0 0 16px; font-size: 22px; font-weight: 600; line-height: 1.3; color: #09090b; letter-spacing: -0.3px;">Your recovered {{{product_name}}} license</h1>
                <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.6; color: #3f3f46;">A new license key has been generated for your {{{product_name}}} license. Any previous key has been deactivated.</p>
                <div style="background-color: #f9fafb; border: 1px solid #e4e4e7; border-radius: 8px; padding: 16px 20px; margin: 0 0 24px;">
                  <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; color: #71717a; margin-bottom: 8px;">New License Key (v{{{key_version}}})</div>
                  <div style="font-family: ui-monospace, 'SFMono-Regular', Menlo, Monaco, Consolas, monospace; font-size: 15px; font-weight: 500; color: #09090b; word-break: break-all; letter-spacing: 0.5px;">{{{license_key}}}</div>
                </div>
                <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 0 0 24px; font-size: 14px; border-top: 1px solid #f4f4f5;">
                  <tr>
                    <td style="padding: 10px 0; color: #71717a; border-bottom: 1px solid #f4f4f5; width: 120px;">Product</td>
                    <td style="padding: 10px 0; color: #09090b; font-weight: 500; border-bottom: 1px solid #f4f4f5;">{{{product_name}}}</td>
                  </tr>
                  <tr>
                    <td style="padding: 10px 0; color: #71717a; border-bottom: 1px solid #f4f4f5;">Key Version</td>
                    <td style="padding: 10px 0; color: #09090b; font-weight: 500; border-bottom: 1px solid #f4f4f5;">{{{key_version}}}</td>
                  </tr>
                </table>
                <p style="margin: 0 0 24px; font-size: 13px; line-height: 1.5; color: #71717a;">If you did not request this recovery, please contact support immediately.</p>
                <div style="border-top: 1px solid #f4f4f5; padding-top: 20px; font-size: 12px; line-height: 1.5; color: #a1a1aa;">
                  Sent by {{{instance_name}}} &middot; Powered by LicenKit
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
    text: `Your recovered {{{product_name}}} license

A new license key has been generated for your {{{product_name}}} license. Any previous key has been deactivated.

New License Key (v{{{key_version}}}):
{{{license_key}}}

Details:
- Product: {{{product_name}}}
- Key Version: {{{key_version}}}

If you did not request this recovery, please contact support immediately.

---
Sent by {{{instance_name}}} · Powered by LicenKit
`,
  }),
  example({
    provider: "resend",
    notificationType: "customer.license_security_reset",
    contractVersion: 1,
    fileName: "customer-license-security-reset-v1.resend.html",
    subject: "Security reset for your {{{product_name}}} license",
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  </head>
  <body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #18181b; -webkit-font-smoothing: antialiased;">
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f4f4f5; padding: 40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 520px; background-color: #ffffff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 36px 32px; text-align: left; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);">
            <tr>
              <td>
                <div style="font-size: 13px; font-weight: 600; color: #71717a; letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 20px;">{{{instance_name}}}</div>
                <h1 style="margin: 0 0 16px; font-size: 22px; font-weight: 600; line-height: 1.3; color: #09090b; letter-spacing: -0.3px;">Your {{{product_name}}} license was reset</h1>
                <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.6; color: #3f3f46;">A security reset has been completed for your {{{product_name}}} license. All previous license keys and existing device activations have been revoked.</p>
                <div style="background-color: #f9fafb; border: 1px solid #e4e4e7; border-radius: 8px; padding: 16px 20px; margin: 0 0 24px;">
                  <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; color: #71717a; margin-bottom: 8px;">New License Key (v{{{key_version}}})</div>
                  <div style="font-family: ui-monospace, 'SFMono-Regular', Menlo, Monaco, Consolas, monospace; font-size: 15px; font-weight: 500; color: #09090b; word-break: break-all; letter-spacing: 0.5px;">{{{license_key}}}</div>
                </div>
                <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 0 0 24px; font-size: 14px; border-top: 1px solid #f4f4f5;">
                  <tr>
                    <td style="padding: 10px 0; color: #71717a; border-bottom: 1px solid #f4f4f5; width: 120px;">Product</td>
                    <td style="padding: 10px 0; color: #09090b; font-weight: 500; border-bottom: 1px solid #f4f4f5;">{{{product_name}}}</td>
                  </tr>
                  <tr>
                    <td style="padding: 10px 0; color: #71717a; border-bottom: 1px solid #f4f4f5;">Key Version</td>
                    <td style="padding: 10px 0; color: #09090b; font-weight: 500; border-bottom: 1px solid #f4f4f5;">{{{key_version}}}</td>
                  </tr>
                </table>
                <p style="margin: 0 0 24px; font-size: 13px; line-height: 1.5; color: #71717a;">Please re-activate your devices using the new license key above.</p>
                <div style="border-top: 1px solid #f4f4f5; padding-top: 20px; font-size: 12px; line-height: 1.5; color: #a1a1aa;">
                  Sent by {{{instance_name}}} &middot; Powered by LicenKit
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
    text: `Your {{{product_name}}} license was reset

A security reset has been completed for your {{{product_name}}} license. All previous license keys and existing device activations have been revoked.

New License Key (v{{{key_version}}}):
{{{license_key}}}

Details:
- Product: {{{product_name}}}
- Key Version: {{{key_version}}}

Please re-activate your devices using the new license key above.

---
Sent by {{{instance_name}}} · Powered by LicenKit
`,
  }),
  example({
    provider: "resend",
    notificationType: "customer.portal_access_requested",
    contractVersion: 1,
    fileName: "customer-portal-access-requested-v1.resend.html",
    subject: "Sign in to {{{instance_name}}}",
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  </head>
  <body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #18181b; -webkit-font-smoothing: antialiased;">
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f4f4f5; padding: 40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 520px; background-color: #ffffff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 36px 32px; text-align: left; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);">
            <tr>
              <td>
                <div style="font-size: 13px; font-weight: 600; color: #71717a; letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 20px;">{{{instance_name}}}</div>
                <h1 style="margin: 0 0 16px; font-size: 22px; font-weight: 600; line-height: 1.3; color: #09090b; letter-spacing: -0.3px;">Sign in to your customer portal</h1>
                <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.6; color: #3f3f46;">Use the secure button below to sign in to your customer portal.</p>
                <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 0 0 24px;">
                  <tr>
                    <td>
                      <a href="{{{access_url}}}" target="_blank" style="display: inline-block; background-color: #18181b; color: #ffffff; font-size: 14px; font-weight: 500; text-decoration: none; padding: 12px 22px; border-radius: 8px; line-height: 1;">
                        Open Customer Portal &rarr;
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin: 0 0 24px; font-size: 13px; line-height: 1.5; color: #71717a;">This link expires at {{{expires_at}}} and can only be used once. If you did not request this email, you can safely ignore it.</p>
                <div style="border-top: 1px solid #f4f4f5; padding-top: 20px; font-size: 12px; line-height: 1.5; color: #a1a1aa;">
                  Sent by {{{instance_name}}} &middot; Powered by LicenKit
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
    text: `Sign in to your customer portal

Use the link below to sign in to {{{instance_name}}}:
{{{access_url}}}

This link expires at {{{expires_at}}} and can only be used once.
If you did not request this email, you can safely ignore it.

---
Sent by {{{instance_name}}} · Powered by LicenKit
`,
  }),
  example({
    provider: "resend",
    notificationType: "instance.member_invited",
    contractVersion: 1,
    fileName: "instance-member-invited-v1.resend.html",
    subject: "You are invited to {{{instance_name}}}",
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  </head>
  <body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #18181b; -webkit-font-smoothing: antialiased;">
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f4f4f5; padding: 40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 520px; background-color: #ffffff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 36px 32px; text-align: left; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);">
            <tr>
              <td>
                <div style="font-size: 13px; font-weight: 600; color: #71717a; letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 20px;">{{{instance_name}}}</div>
                <h1 style="margin: 0 0 16px; font-size: 22px; font-weight: 600; line-height: 1.3; color: #09090b; letter-spacing: -0.3px;">Join {{{instance_name}}}</h1>
                <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.6; color: #3f3f46;">You have been invited to join the team on {{{instance_name}}}. Click the button below to accept your invitation.</p>
                <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 0 0 24px;">
                  <tr>
                    <td>
                      <a href="{{{invitation_url}}}" target="_blank" style="display: inline-block; background-color: #18181b; color: #ffffff; font-size: 14px; font-weight: 500; text-decoration: none; padding: 12px 22px; border-radius: 8px; line-height: 1;">
                        Accept Invitation &rarr;
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin: 0 0 24px; font-size: 13px; line-height: 1.5; color: #71717a;">This invitation expires at {{{expires_at}}} and can only be used once. If you did not expect this invitation, you can safely ignore it.</p>
                <div style="border-top: 1px solid #f4f4f5; padding-top: 20px; font-size: 12px; line-height: 1.5; color: #a1a1aa;">
                  Sent by {{{instance_name}}} &middot; Powered by LicenKit
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
    text: `Join {{{instance_name}}}

You have been invited to join the team on {{{instance_name}}}.

Accept your invitation:
{{{invitation_url}}}

This invitation expires at {{{expires_at}}} and can only be used once.
If you did not expect this invitation, you can safely ignore it.

---
Sent by {{{instance_name}}} · Powered by LicenKit
`,
  }),
] satisfies readonly EmailProviderTemplateExample[]);

const RESEND_TEMPLATE_EXAMPLES = Object.freeze([
  ...BASE_RESEND_TEMPLATE_EXAMPLES,
  ...BASE_RESEND_TEMPLATE_EXAMPLES
    .filter((item) => item.notificationType.startsWith("customer.license_"))
    .map((item) => example({
      ...item,
      notificationType: item.notificationType.replace("customer.license_", "customer.sandbox_license_"),
      fileName: item.fileName.replace("-v1.", "-sandbox-v1."),
      subject: "[Sandbox] " + item.subject,
      html: item.html
        .replace(
          "</h1>",
          "</h1><p style=\"color: #9a3412; font-weight: 700;\">Sandbox test license. This key cannot activate the live application.</p>",
        )
        .replace(
          "Here is your license key to activate {{{product_name}}}.",
          "This Sandbox key cannot activate the live {{{product_name}}} application.",
        )
        .replace(
          "Please re-activate your devices using the new license key above.",
          "This Sandbox key cannot activate the live application.",
        ),
      text: "SANDBOX TEST LICENSE — Cannot activate the live application.\n\n" +
        item.text
          .replace(
            "Here is your license key to activate {{{product_name}}}.",
            "This Sandbox key cannot activate the live {{{product_name}}} application.",
          )
          .replace(
            "Please re-activate your devices using the new license key above.",
            "This Sandbox key cannot activate the live application.",
          ),
    })),
]);

const RESEND_TEMPLATE_EXAMPLE_REGISTRY: Readonly<
  Record<string, EmailProviderTemplateExample>
> = Object.freeze(
  Object.fromEntries(
    RESEND_TEMPLATE_EXAMPLES.map((item) => [
      exampleKey(item.notificationType, item.contractVersion),
      item,
    ]),
  ),
);

export const EMAIL_PROVIDER_TEMPLATE_REGISTRY: Readonly<
  Record<string, EmailProviderTemplateRegistryEntry>
> = Object.freeze({
  resend: Object.freeze({
    placeholderSyntax: "{{{variable_name}}}",
    examples: RESEND_TEMPLATE_EXAMPLE_REGISTRY,
    validateVariables: validateResendTemplateVariables,
  }),
});

function requireProvider(provider: string): EmailProviderTemplateRegistryEntry {
  const registered = EMAIL_PROVIDER_TEMPLATE_REGISTRY[provider];
  if (!registered) {
    throw providerError(
      "EMAIL_PROVIDER_NOT_REGISTERED",
      "The requested email Provider is not registered.",
      { provider },
      404,
    );
  }
  return registered;
}

export function getEmailProviderTemplateExample(
  provider: string,
  notificationType: string,
  contractVersion: number,
): EmailProviderTemplateExampleResponse {
  const registeredProvider = requireProvider(provider);
  const registeredExample =
    registeredProvider.examples[exampleKey(notificationType, contractVersion)];
  if (!registeredExample) {
    throw providerError(
      "EMAIL_PROVIDER_TEMPLATE_EXAMPLE_NOT_REGISTERED",
      "No template example is registered for this Provider and email contract.",
      { provider, notificationType, contractVersion },
      404,
    );
  }
  // A Provider example may never outlive its LicenKit contract definition.
  getEmailNotificationContract(notificationType, contractVersion);
  return Object.freeze({
    ...registeredExample,
    placeholderSyntax: registeredProvider.placeholderSyntax,
  });
}

export function validateEmailProviderTemplateVariables(
  provider: string,
  variables: Readonly<Record<string, EmailVariableValue>>,
): void {
  requireProvider(provider).validateVariables(variables);
}
