import { ipcRenderer } from "electron";
import {
  BB_DESKTOP_PERSONAL_ONBOARDING_CHOOSE_CHANNEL,
  PERSONAL_ONBOARDING_CHOICES,
  type PersonalOnboardingChoice,
} from "./personal-onboarding-ipc.js";

window.addEventListener("DOMContentLoaded", () => {
  function choose(choice: PersonalOnboardingChoice): void {
    ipcRenderer.send(BB_DESKTOP_PERSONAL_ONBOARDING_CHOOSE_CHANNEL, { choice });
  }

  for (const choice of PERSONAL_ONBOARDING_CHOICES) {
    document
      .querySelector<HTMLButtonElement>(`button[data-choice="${choice}"]`)
      ?.addEventListener("click", () => {
        choose(choice);
      });
  }

  document.querySelector<HTMLButtonElement>("button[data-primary]")?.focus();

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      choose("quit");
    }
  });
});
