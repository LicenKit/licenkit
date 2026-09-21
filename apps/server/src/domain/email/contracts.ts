import { z } from "zod";
import { AppError } from "../../middleware/error";

export type EmailVariableValue = string | number;
export type EmailVariableFormat = "email" | "uri" | "date-time";

export interface EmailVariableDescriptor {
  readonly name: string;
  readonly type: "string" | "number";
  readonly required: boolean;
  readonly sensitive: boolean;
  readonly format?: EmailVariableFormat;
  readonly enumValues?: readonly EmailVariableValue[];
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly integer?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly description: string;
  readonly example: EmailVariableValue;
}

export interface EmailNotificationContract {
  readonly notificationType: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly variables: readonly EmailVariableDescriptor[];
}

export interface EmailVariableValidationContext {
  /**
   * The current instances.site_url value. It is required when a
   * contract contains access_url so arbitrary caller-provided URLs cannot be
   * accepted merely because they are valid HTTPS URLs.
   */
  readonly trustedSiteUrl?: string;
  /** The current Instance slug expected in a customer portal access URL. */
  readonly expectedInstanceSlug?: string;
}

export interface CustomerPortalAccessUrlInput {
  readonly trustedSiteUrl: string;
  readonly instanceSlug: string;
  readonly oneTimeToken: string;
}

const EMAIL_SCHEMA = z.string().email().max(320);
const INSTANCE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LICENKIT_PRODUCT_ID_PATTERN = /^prd_[0-9a-hjkmnp-tv-z]{26}$/;
const LICENKIT_LICENSE_ID_PATTERN = /^lic_[0-9a-hjkmnp-tv-z]{26}$/;
const LICENSE_KEY_PATTERN = /^LK-[0-9A-HJKMNP-TV-Z]{6}(?:-[0-9A-HJKMNP-TV-Z]{6}){3}-[0-9A-HJKMNP-TV-Z]{2}$/;
const CUSTOMER_PORTAL_TOKEN_PATTERN = /^mlk_[0-9a-f]{64}$/;
const INSTANCE_INVITATION_TOKEN_PATTERN = /^ivk_[0-9a-f]{64}$/;

function variable(
  descriptor: EmailVariableDescriptor,
): EmailVariableDescriptor {
  return Object.freeze({
    ...descriptor,
    ...(descriptor.enumValues
      ? { enumValues: Object.freeze([...descriptor.enumValues]) }
      : {}),
  });
}

export const COMMON_EMAIL_VARIABLES = Object.freeze([
  variable({
    name: "instance_name",
    type: "string",
    required: true,
    sensitive: false,
    minLength: 1,
    maxLength: 120,
    description: "当前 Instance 显示名称",
    example: "Example Team",
  }),
] satisfies readonly EmailVariableDescriptor[]);

const LICENSE_IDENTITY_VARIABLES = Object.freeze([
  variable({
    name: "product_id",
    type: "string",
    required: true,
    sensitive: false,
    pattern: LICENKIT_PRODUCT_ID_PATTERN.source,
    minLength: 30,
    maxLength: 30,
    description: "LicenKit Product ID",
    example: "prd_00000000000000000000000000",
  }),
  variable({
    name: "product_name",
    type: "string",
    required: true,
    sensitive: false,
    minLength: 1,
    maxLength: 100,
    description: "产品显示名称",
    example: "Example App",
  }),
  variable({
    name: "license_id",
    type: "string",
    required: true,
    sensitive: false,
    pattern: LICENKIT_LICENSE_ID_PATTERN.source,
    minLength: 30,
    maxLength: 30,
    description: "LicenKit License ID",
    example: "lic_00000000000000000000000000",
  }),
  variable({
    name: "license_key",
    type: "string",
    required: true,
    sensitive: true,
    pattern: LICENSE_KEY_PATTERN.source,
    minLength: 33,
    maxLength: 33,
    description: "本次邮件中一次性可见的新授权码",
    example: "LK-000000-000000-000000-000000-00",
  }),
  variable({
    name: "license_model",
    type: "string",
    required: true,
    sensitive: false,
    enumValues: ["perpetual", "fixed_term", "subscription"],
    minLength: 1,
    maxLength: 32,
    description: "License 模型",
    example: "subscription",
  }),
] satisfies readonly EmailVariableDescriptor[]);

const OPTIONAL_LICENSE_TERM_VARIABLES = Object.freeze([
  variable({
    name: "expires_at",
    type: "string",
    required: false,
    sensitive: false,
    format: "date-time",
    minLength: 20,
    maxLength: 64,
    description: "License 到期时间，使用 ISO 8601 UTC date-time",
    example: "2026-10-19T10:00:00.000Z",
  }),
  variable({
    name: "updates_until",
    type: "string",
    required: false,
    sensitive: false,
    format: "date-time",
    minLength: 20,
    maxLength: 64,
    description: "永久授权的更新权益截止时间，使用 ISO 8601 UTC date-time",
    example: "2027-10-19T10:00:00.000Z",
  }),
] satisfies readonly EmailVariableDescriptor[]);

const KEY_VERSION_VARIABLE = variable({
  name: "key_version",
  type: "number",
  required: true,
  sensitive: false,
  integer: true,
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
  description: "新授权码版本",
  example: 2,
});

const PORTAL_ACCESS_VARIABLES = Object.freeze([
  variable({
    name: "access_url",
    type: "string",
    required: true,
    sensitive: true,
    format: "uri",
    minLength: 1,
    maxLength: 2048,
    description: "由 LicenKit 可信站点配置生成且包含一次性 Token 的完整访问地址",
    example:
      "https://license.example.com/customer/example-team/auth#token=mlk_0000000000000000000000000000000000000000000000000000000000000000",
  }),
  variable({
    name: "expires_at",
    type: "string",
    required: true,
    sensitive: false,
    format: "date-time",
    minLength: 20,
    maxLength: 64,
    description: "Magic Link 到期时间，使用 ISO 8601 UTC date-time",
    example: "2026-10-19T10:15:00.000Z",
  }),
] satisfies readonly EmailVariableDescriptor[]);

const INSTANCE_INVITATION_VARIABLES = Object.freeze([
  variable({
    name: "invitation_url",
    type: "string",
    required: true,
    sensitive: true,
    format: "uri",
    minLength: 1,
    maxLength: 2048,
    description: "由当前 Instance 的可信 Site URL Origin 生成的一次性管理员邀请地址",
    example:
      "https://license.example.com/admin/invitations/accept#token=ivk_0000000000000000000000000000000000000000000000000000000000000000",
  }),
  variable({
    name: "expires_at",
    type: "string",
    required: true,
    sensitive: false,
    format: "date-time",
    minLength: 20,
    maxLength: 64,
    description: "Instance 邀请到期时间，使用 ISO 8601 UTC date-time",
    example: "2026-10-19T10:15:00.000Z",
  }),
] satisfies readonly EmailVariableDescriptor[]);

function contract(
  value: EmailNotificationContract,
): EmailNotificationContract {
  return Object.freeze({
    ...value,
    variables: Object.freeze([...value.variables]),
  });
}

export const EMAIL_NOTIFICATION_CONTRACTS = Object.freeze([
  contract({
    notificationType: "customer.license_issued",
    version: 1,
    name: "授权码签发",
    description: "购买履约或管理员签发 License 后发送新的授权码。",
    variables: [
      ...COMMON_EMAIL_VARIABLES,
      ...LICENSE_IDENTITY_VARIABLES,
      ...OPTIONAL_LICENSE_TERM_VARIABLES,
    ],
  }),
  contract({
    notificationType: "customer.license_recovered",
    version: 1,
    name: "授权码找回",
    description: "客户或管理员找回 License 时发送轮换后的授权码。",
    variables: [
      ...COMMON_EMAIL_VARIABLES,
      ...LICENSE_IDENTITY_VARIABLES,
      KEY_VERSION_VARIABLE,
      ...OPTIONAL_LICENSE_TERM_VARIABLES,
    ],
  }),
  contract({
    notificationType: "customer.license_security_reset",
    version: 1,
    name: "授权安全重置",
    description: "安全重置 License 后发送新授权码，并说明旧授权与现有 Activation 已失效。",
    variables: [
      ...COMMON_EMAIL_VARIABLES,
      ...LICENSE_IDENTITY_VARIABLES,
      KEY_VERSION_VARIABLE,
      ...OPTIONAL_LICENSE_TERM_VARIABLES,
    ],
  }),
  contract({
    notificationType: "customer.portal_access_requested",
    version: 1,
    name: "客户门户访问",
    description: "客户请求访问 Customer Portal 时发送一次性 Magic Link。",
    variables: [...COMMON_EMAIL_VARIABLES, ...PORTAL_ACCESS_VARIABLES],
  }),
  contract({
    notificationType: "instance.member_invited",
    version: 1,
    name: "实例成员邀请",
    description: "Instance Owner 邀请成员时发送一次性管理员邀请链接。",
    variables: [...COMMON_EMAIL_VARIABLES, ...INSTANCE_INVITATION_VARIABLES],
  }),
] satisfies readonly EmailNotificationContract[]);

function contractKey(notificationType: string, version: number): string {
  return `${notificationType}@${version}`;
}

export const EMAIL_NOTIFICATION_CONTRACT_REGISTRY: Readonly<
  Record<string, EmailNotificationContract>
> = Object.freeze(
  Object.fromEntries(
    EMAIL_NOTIFICATION_CONTRACTS.map((item) => [
      contractKey(item.notificationType, item.version),
      item,
    ]),
  ),
);

function contractError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: 400 | 404 | 500 = 400,
): AppError {
  return new AppError(code, message, status, details);
}

export function listEmailNotificationContracts(): readonly EmailNotificationContract[] {
  return EMAIL_NOTIFICATION_CONTRACTS;
}

export function getEmailNotificationContract(
  notificationType: string,
  version: number,
): EmailNotificationContract {
  const found = EMAIL_NOTIFICATION_CONTRACT_REGISTRY[contractKey(notificationType, version)];
  if (!found) {
    throw contractError(
      "EMAIL_NOTIFICATION_CONTRACT_NOT_REGISTERED",
      "The requested email notification contract is not registered.",
      { notificationType, version },
      404,
    );
  }
  return found;
}

function parseTrustedSiteUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw contractError(
      "EMAIL_TRUSTED_SITE_URL_INVALID",
      "The trusted Site URL configuration is invalid.",
      undefined,
      500,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw contractError(
      "EMAIL_TRUSTED_SITE_URL_INVALID",
      "The trusted Site URL must be an HTTPS URL without credentials, query parameters, or a fragment.",
      undefined,
      500,
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url;
}

export function buildCustomerPortalAccessUrl(
  input: CustomerPortalAccessUrlInput,
): string {
  const siteUrl = parseTrustedSiteUrl(input.trustedSiteUrl);
  if (
    !INSTANCE_SLUG_PATTERN.test(input.instanceSlug) ||
    input.instanceSlug.length > 63
  ) {
    throw contractError(
      "EMAIL_PORTAL_INSTANCE_SLUG_INVALID",
      "The Instance slug for the customer portal access URL is invalid.",
      { field: "instanceSlug" },
    );
  }
  if (!CUSTOMER_PORTAL_TOKEN_PATTERN.test(input.oneTimeToken)) {
    throw contractError(
      "EMAIL_PORTAL_TOKEN_INVALID",
      "The one-time token for the customer portal access URL has an invalid format.",
      { field: "oneTimeToken" },
    );
  }

  const pathPrefix = siteUrl.pathname === "/" ? "" : siteUrl.pathname;
  const accessUrl = new URL(siteUrl.origin);
  accessUrl.pathname = `${pathPrefix}/customer/${encodeURIComponent(input.instanceSlug)}/auth`;
  accessUrl.hash = `token=${encodeURIComponent(input.oneTimeToken)}`;
  return accessUrl.toString();
}

function isValidIsoUtcDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(
    value,
  );
  if (!match) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  return (
    parsed.getUTCFullYear() === Number(match[1]) &&
    parsed.getUTCMonth() + 1 === Number(match[2]) &&
    parsed.getUTCDate() === Number(match[3]) &&
    parsed.getUTCHours() === Number(match[4]) &&
    parsed.getUTCMinutes() === Number(match[5]) &&
    parsed.getUTCSeconds() === Number(match[6])
  );
}

function isValidUri(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.protocol && url.hostname);
  } catch {
    return false;
  }
}

function assertTrustedPortalAccessUrl(
  value: string,
  context: EmailVariableValidationContext,
): void {
  if (!context.trustedSiteUrl) {
    throw contractError(
      "EMAIL_TRUSTED_SITE_URL_REQUIRED",
      "The trusted Site URL is required to validate access_url.",
      { variable: "access_url" },
    );
  }
  if (!context.expectedInstanceSlug) {
    throw contractError(
      "EMAIL_EXPECTED_INSTANCE_SLUG_REQUIRED",
      "The expected Instance slug is required to validate access_url.",
      { variable: "access_url" },
    );
  }
  if (
    !INSTANCE_SLUG_PATTERN.test(context.expectedInstanceSlug) ||
    context.expectedInstanceSlug.length > 63
  ) {
    throw contractError(
      "EMAIL_EXPECTED_INSTANCE_SLUG_INVALID",
      "The expected Instance slug used to validate access_url is invalid.",
      { variable: "access_url" },
    );
  }
  const siteUrl = parseTrustedSiteUrl(context.trustedSiteUrl);
  let accessUrl: URL;
  try {
    accessUrl = new URL(value);
  } catch {
    throw contractError(
      "EMAIL_CONTRACT_VARIABLE_FORMAT_INVALID",
      "Email variable access_url must be a valid URI.",
      { variable: "access_url", format: "uri" },
    );
  }

  const sitePath = siteUrl.pathname === "/" ? "" : siteUrl.pathname;
  const relativePath = accessUrl.pathname.startsWith(`${sitePath}/`)
    ? accessUrl.pathname.slice(sitePath.length)
    : "";
  const token = accessUrl.hash.startsWith("#token=")
    ? accessUrl.hash.slice("#token=".length)
    : "";
  const expectedPath = `/customer/${context.expectedInstanceSlug}/auth`;
  if (
    accessUrl.protocol !== "https:" ||
    accessUrl.origin !== siteUrl.origin ||
    accessUrl.username ||
    accessUrl.password ||
    accessUrl.search ||
    relativePath !== expectedPath ||
    !CUSTOMER_PORTAL_TOKEN_PATTERN.test(token)
  ) {
    throw contractError(
      "EMAIL_ACCESS_URL_UNTRUSTED",
      "Email variable access_url was not generated from the trusted Site URL boundary.",
      { variable: "access_url" },
    );
  }
}

function assertTrustedInstanceInvitationUrl(
  value: string,
  context: EmailVariableValidationContext,
): void {
  if (!context.trustedSiteUrl) {
    throw contractError(
      "EMAIL_TRUSTED_SITE_URL_REQUIRED",
      "The trusted Site URL is required to validate invitation_url.",
      { variable: "invitation_url" },
    );
  }
  const siteUrl = parseTrustedSiteUrl(context.trustedSiteUrl);
  let invitationUrl: URL;
  try {
    invitationUrl = new URL(value);
  } catch {
    throw contractError(
      "EMAIL_CONTRACT_VARIABLE_FORMAT_INVALID",
      "Email variable invitation_url must be a valid URI.",
      { variable: "invitation_url", format: "uri" },
    );
  }
  const token = invitationUrl.hash.startsWith("#token=")
    ? invitationUrl.hash.slice("#token=".length)
    : "";
  if (
    invitationUrl.protocol !== "https:" ||
    invitationUrl.origin !== siteUrl.origin ||
    invitationUrl.username ||
    invitationUrl.password ||
    invitationUrl.search ||
    invitationUrl.pathname !== "/admin/invitations/accept" ||
    !INSTANCE_INVITATION_TOKEN_PATTERN.test(token)
  ) {
    throw contractError(
      "EMAIL_INVITATION_URL_UNTRUSTED",
      "Email variable invitation_url was not generated from the trusted Instance invitation boundary.",
      { variable: "invitation_url" },
    );
  }
}

function assertStringVariable(
  descriptor: EmailVariableDescriptor,
  value: string,
  context: EmailVariableValidationContext,
): void {
  if (
    (descriptor.minLength !== undefined && value.length < descriptor.minLength) ||
    (descriptor.maxLength !== undefined && value.length > descriptor.maxLength)
  ) {
    throw contractError(
      "EMAIL_CONTRACT_VARIABLE_LENGTH_INVALID",
      `Email variable ${descriptor.name} has an invalid length.`,
      {
        variable: descriptor.name,
        minLength: descriptor.minLength,
        maxLength: descriptor.maxLength,
      },
    );
  }
  if (descriptor.pattern && !new RegExp(descriptor.pattern).test(value)) {
    throw contractError(
      "EMAIL_CONTRACT_VARIABLE_PATTERN_INVALID",
      `Email variable ${descriptor.name} does not match its required format.`,
      { variable: descriptor.name },
    );
  }
  if (descriptor.format === "email" && !EMAIL_SCHEMA.safeParse(value).success) {
    throw contractError(
      "EMAIL_CONTRACT_VARIABLE_FORMAT_INVALID",
      `Email variable ${descriptor.name} must be a valid email address.`,
      { variable: descriptor.name, format: "email" },
    );
  }
  if (descriptor.format === "date-time" && !isValidIsoUtcDateTime(value)) {
    throw contractError(
      "EMAIL_CONTRACT_VARIABLE_FORMAT_INVALID",
      `Email variable ${descriptor.name} must be a valid ISO 8601 UTC date-time.`,
      { variable: descriptor.name, format: "date-time" },
    );
  }
  if (descriptor.format === "uri" && !isValidUri(value)) {
    throw contractError(
      "EMAIL_CONTRACT_VARIABLE_FORMAT_INVALID",
      `Email variable ${descriptor.name} must be a valid URI.`,
      { variable: descriptor.name, format: "uri" },
    );
  }
  if (descriptor.name === "access_url") {
    assertTrustedPortalAccessUrl(value, context);
  }
  if (descriptor.name === "invitation_url") {
    assertTrustedInstanceInvitationUrl(value, context);
  }
}

export function validateEmailNotificationVariables(
  notificationType: string,
  version: number,
  variables: unknown,
  context: EmailVariableValidationContext = {},
): Readonly<Record<string, EmailVariableValue>> {
  const registered = getEmailNotificationContract(notificationType, version);
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    throw contractError(
      "EMAIL_CONTRACT_VARIABLES_INVALID",
      "Email variables must be an object.",
    );
  }

  const input = variables as Record<string, unknown>;
  const descriptors = new Map(
    registered.variables.map((descriptor) => [descriptor.name, descriptor]),
  );
  const providedNames = Object.keys(input);
  for (const [position, name] of providedNames.entries()) {
    if (!descriptors.has(name)) {
      throw contractError(
        "EMAIL_CONTRACT_VARIABLE_UNKNOWN",
        "An email variable is not registered for this contract.",
        { position, providedCount: providedNames.length, notificationType, version },
      );
    }
  }

  for (const descriptor of registered.variables) {
    if (descriptor.required && !Object.prototype.hasOwnProperty.call(input, descriptor.name)) {
      throw contractError(
        "EMAIL_CONTRACT_VARIABLE_REQUIRED",
        `Required email variable ${descriptor.name} is missing.`,
        { variable: descriptor.name, notificationType, version },
      );
    }
  }

  const validated: Record<string, EmailVariableValue> = {};
  for (const [name, rawValue] of Object.entries(input)) {
    const descriptor = descriptors.get(name)!;
    if (typeof rawValue !== descriptor.type) {
      throw contractError(
        "EMAIL_CONTRACT_VARIABLE_TYPE_INVALID",
        `Email variable ${name} has an invalid type.`,
        { variable: name, expectedType: descriptor.type },
      );
    }
    const value = rawValue as EmailVariableValue;
    if (
      descriptor.enumValues &&
      !descriptor.enumValues.some((enumValue) => enumValue === value)
    ) {
      throw contractError(
        "EMAIL_CONTRACT_VARIABLE_ENUM_INVALID",
        `Email variable ${name} is not an allowed value.`,
        { variable: name, enumValues: descriptor.enumValues },
      );
    }
    if (typeof value === "string") {
      assertStringVariable(descriptor, value, context);
    } else if (
      !Number.isFinite(value) ||
      (descriptor.integer === true && !Number.isSafeInteger(value)) ||
      (descriptor.minimum !== undefined && value < descriptor.minimum) ||
      (descriptor.maximum !== undefined && value > descriptor.maximum)
    ) {
      throw contractError(
        "EMAIL_CONTRACT_VARIABLE_NUMBER_INVALID",
        `Email variable ${name} has an invalid numeric value.`,
        {
          variable: name,
          integer: descriptor.integer,
          minimum: descriptor.minimum,
          maximum: descriptor.maximum,
        },
      );
    }
    validated[name] = value;
  }

  return Object.freeze(validated);
}
