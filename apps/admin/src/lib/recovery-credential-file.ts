export interface RecoveryCredentialFile {
  email: string;
  credential: string;
  adminUrl: string;
}

export function recoveryCredentialText(input: RecoveryCredentialFile): string {
  return [
    "LicenKit 恢复凭据 / Recovery credential", "",
    `登录地址 / Sign-in URL: ${input.adminUrl}/admin/`,
    `登录邮箱 / Sign-in email: ${input.email}`,
    `恢复凭据 / Recovery credential: ${input.credential}`, "",
    "持有此文件的人可以重置此账号密码，请妥善保管，不要向他人提供。",
    "忘记密码且无法收取邮件时，打开上述登录地址，选择“忘记密码”→“使用恢复凭据找回”。",
    "凭据仅可使用一次，使用后请保存系统提供的新凭据。重新生成后，旧凭据立即失效。", "",
    "Anyone with this file can reset this account. Keep it secure and do not share it.",
    "Open the sign-in URL, choose Forgot password, then Use a recovery credential.",
    "This credential works once. Save its replacement after use. Regeneration invalidates the old credential.", "",
  ].join("\n");
}

export function parseRecoveryCredentialFile(text: string): { email: string; credential: string } | null {
  if (text.length > 8192) return null;
  const credentials = [...text.matchAll(/^恢复凭据 \/ Recovery credential: (rcv_[0-9a-f]{64})\r?$/gm)];
  const emails = [...text.matchAll(/^登录邮箱 \/ Sign-in email: ([^\r\n]+)\r?$/gm)];
  if (credentials.length !== 1 || emails.length !== 1 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emails[0][1])) return null;
  return { email: emails[0][1], credential: credentials[0][1] };
}

export function downloadRecoveryCredential(input: RecoveryCredentialFile): void {
  const url = URL.createObjectURL(new Blob([recoveryCredentialText(input)], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "LicenKit-恢复凭据.txt";
  document.body.appendChild(link);
  try { link.click() }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
}
