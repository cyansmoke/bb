import { z } from "zod";

export const BB_DESKTOP_PERSONAL_ONBOARDING_CHOOSE_CHANNEL =
  "bb-desktop:personal-onboarding:choose";

export const PERSONAL_ONBOARDING_CHOICES = ["fresh", "import", "quit"] as const;

export const personalOnboardingChooseRequestSchema = z
  .object({ choice: z.enum(PERSONAL_ONBOARDING_CHOICES) })
  .strict();
export type PersonalOnboardingChoice = z.infer<
  typeof personalOnboardingChooseRequestSchema
>["choice"];
