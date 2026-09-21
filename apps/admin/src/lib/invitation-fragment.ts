export function invitationTokenFromFragment(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const tokens = params.getAll("token");
  if (tokens.length !== 1) return null;
  const token = tokens[0]?.trim();
  return token ? token : null;
}

export function urlWithoutFragment(location: Pick<Location, "pathname" | "search">): string {
  return `${location.pathname}${location.search}`;
}

export function readAndClearInvitationToken(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState" | "state">,
): string | null {
  const token = invitationTokenFromFragment(location.hash);
  history.replaceState(history.state, "", urlWithoutFragment(location));
  return token;
}
