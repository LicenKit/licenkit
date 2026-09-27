import type { EntitlementState } from "./client-api";

function detailLines(details: Record<string, string>): string[] {
  return Object.entries(details).map(([key, value]) => "Detail " + key + ": " + value);
}

export function entitlementStateIsUsable(state: EntitlementState): boolean {
  return (state.kind === "license" || state.kind === "trial") && state.status === "active";
}

export function describeEntitlementState(state: EntitlementState): string[] {
  if (state.kind === "activation_required") {
    if (state.trial.status === "available") {
      return [
        "Activation required",
        "Trial availability: available",
        "Trial duration seconds: " + state.trial.duration_seconds,
        "Trial features: " + (state.trial.features.join(", ") || "(none)"),
      ];
    }
    return [
      "Activation required",
      "Trial availability: unavailable",
      "Code: " + state.trial.code,
      "Reason: " + state.trial.reason,
      ...detailLines(state.trial.details),
    ];
  }
  if (state.kind === "trial") {
    if (state.status === "active") {
      return [
        "Trial active",
        "Expires at: " + state.expires_at,
        "Features: " + (state.features.join(", ") || "(none)"),
      ];
    }
    if (state.status === "expired") {
      return [
        "Trial expired",
        "Code: " + state.code,
        "Expires at: " + (state.expires_at ?? "unknown"),
        ...detailLines(state.details),
      ];
    }
    return [
      "Trial revoked",
      "Code: " + state.code,
      ...(state.reason ? ["Reason: " + state.reason] : []),
      ...detailLines(state.details),
    ];
  }
  if (state.kind === "license") {
    if (state.status === "active") {
      return [
        "License active",
        "Expires at: " + (state.expires_at ?? "never"),
        "Features: " + (state.terms.features.join(", ") || "(none)"),
      ];
    }
    if (state.status === "expired") {
      return [
        "License expired",
        "Code: " + state.code,
        "Expires at: " + (state.expires_at ?? "unknown"),
        ...detailLines(state.details),
      ];
    }
    if (state.status === "suspended" || state.status === "revoked") {
      return [
        state.status === "suspended" ? "License suspended" : "License revoked",
        "Code: " + state.code,
        ...(state.reason ? ["Reason: " + state.reason] : []),
        ...detailLines(state.details),
      ];
    }
    return [
      state.status === "activation_revoked" ? "Activation revoked" : "Activation deactivated",
      "Code: " + state.code,
      ...detailLines(state.details),
    ];
  }
  return [
    "Release requires newer update entitlement",
    "Code: " + state.code,
    "Release: " + state.release_version + " (" + state.release_platform + "/" + state.release_arch + ")",
    "Updates until: " + (state.updates_until ?? "unknown"),
    "Released at: " + (state.released_at ?? "unknown"),
    ...detailLines(state.details),
  ];
}
