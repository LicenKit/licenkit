export function passwordResetTokenFromFragment(hash: string): string | null {
  const tokens = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash).getAll("token");
  return tokens.length === 1 && /^prk_[0-9a-f]{64}$/.test(tokens[0]) ? tokens[0] : null;
}
