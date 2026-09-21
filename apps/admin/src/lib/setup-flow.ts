export type SetupStep = "token" | "user" | "instance";

export function nextSetupStep(step: SetupStep): SetupStep {
  if (step === "token") return "user";
  if (step === "user") return "instance";
  return "instance";
}

export function previousSetupStep(step: SetupStep): SetupStep {
  if (step === "instance") return "user";
  return "token";
}
