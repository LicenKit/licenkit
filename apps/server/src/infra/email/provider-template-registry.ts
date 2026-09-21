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

const RESEND_TEMPLATE_EXAMPLES = Object.freeze([
  example({
    provider: "resend",
    notificationType: "customer.license_issued",
    contractVersion: 1,
    fileName: "customer-license-issued-v1.resend.html",
    subject: "Your {{{product_name}}} license key",
    html: `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:Arial,sans-serif;color:#1f2937;">
    <main style="max-width:560px;margin:0 auto;background:#ffffff;padding:32px;border-radius:12px;">
      <h1 style="margin-top:0;">Your {{{product_name}}} license</h1>
      <p>{{{account_name}}} has issued a license for {{{product_name}}}.</p>
      <p>Your license key:</p>
      <p style="padding:16px;background:#f3f4f6;border-radius:8px;font-family:monospace;font-size:16px;word-break:break-all;">
        {{{license_key}}}
      </p>
      <p>License model: {{{license_model}}}</p>
    </main>
  </body>
</html>`,
    text: `Your {{{product_name}}} license

{{{account_name}}} has issued a license for {{{product_name}}}.

License key: {{{license_key}}}
License model: {{{license_model}}}

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
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:Arial,sans-serif;color:#1f2937;">
    <main style="max-width:560px;margin:0 auto;background:#ffffff;padding:32px;border-radius:12px;">
      <h1 style="margin-top:0;">Your recovered {{{product_name}}} license</h1>
      <p>{{{account_name}}} has generated a new license key. The previous key is no longer valid.</p>
      <p>Your new license key:</p>
      <p style="padding:16px;background:#f3f4f6;border-radius:8px;font-family:monospace;font-size:16px;word-break:break-all;">
        {{{license_key}}}
      </p>
      <p>Key version: {{{key_version}}}</p>
    </main>
  </body>
</html>`,
    text: `Your recovered {{{product_name}}} license

{{{account_name}}} has generated a new license key. The previous key is no longer valid.

New license key: {{{license_key}}}
Key version: {{{key_version}}}

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
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:Arial,sans-serif;color:#1f2937;">
    <main style="max-width:560px;margin:0 auto;background:#ffffff;padding:32px;border-radius:12px;">
      <h1 style="margin-top:0;">Your {{{product_name}}} license was reset</h1>
      <p>{{{account_name}}} completed a security reset for this license.</p>
      <p>The previous license key and existing device activations are no longer valid.</p>
      <p>Your new license key:</p>
      <p style="padding:16px;background:#f3f4f6;border-radius:8px;font-family:monospace;font-size:16px;word-break:break-all;">
        {{{license_key}}}
      </p>
      <p>Key version: {{{key_version}}}</p>
    </main>
  </body>
</html>`,
    text: `Your {{{product_name}}} license was reset

{{{account_name}}} completed a security reset for this license.
The previous license key and existing device activations are no longer valid.

New license key: {{{license_key}}}
Key version: {{{key_version}}}

`,
  }),
  example({
    provider: "resend",
    notificationType: "customer.portal_access_requested",
    contractVersion: 1,
    fileName: "customer-portal-access-requested-v1.resend.html",
    subject: "Sign in to {{{account_name}}}",
    html: `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:Arial,sans-serif;color:#1f2937;">
    <main style="max-width:560px;margin:0 auto;background:#ffffff;padding:32px;border-radius:12px;">
      <h1 style="margin-top:0;">Sign in to {{{account_name}}}</h1>
      <p>Use the button below to open your customer portal.</p>
      <p style="margin:24px 0;">
        <a href="{{{access_url}}}" style="display:inline-block;padding:12px 18px;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;">
          Open customer portal
        </a>
      </p>
      <p>This link expires at {{{expires_at}}} and can only be used once.</p>
      <p>If you did not request this email, you can ignore it.</p>
    </main>
  </body>
</html>`,
    text: `Sign in to {{{account_name}}}

Open your customer portal:
{{{access_url}}}

This link expires at {{{expires_at}}} and can only be used once.
If you did not request this email, you can ignore it.`,
  }),
] satisfies readonly EmailProviderTemplateExample[]);

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
