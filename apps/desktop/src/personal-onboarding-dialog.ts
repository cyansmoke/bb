import { ipcMain, type BrowserWindow } from "electron";
import { escapeHtmlText } from "@bb/domain";
import {
  createDesktopDialogWindow,
  DESKTOP_DIALOG_BASE_CSS,
  showDesktopDialogHtml,
} from "./desktop-dialog-window.js";
import {
  BB_DESKTOP_PERSONAL_ONBOARDING_CHOOSE_CHANNEL,
  personalOnboardingChooseRequestSchema,
  type PersonalOnboardingChoice,
} from "./personal-onboarding-ipc.js";
import type {
  PersonalImportProgress,
  PersonalProfileImportReport,
  PersonalProfileInspection,
} from "./personal-profile-import.js";

interface OpenPersonalOnboardingDialogArgs {
  inspection: PersonalProfileInspection;
  parentWindow: BrowserWindow | null;
  preloadPath: string;
}

interface OpenPersonalImportProgressArgs {
  parentWindow: BrowserWindow | null;
  preloadPath: string;
}

export interface PersonalImportProgressWindow {
  close(): void;
  update(progress: PersonalImportProgress): void;
}

function inspectionMessage(inspection: PersonalProfileInspection): string {
  switch (inspection.reason) {
    case "ready":
      return `Found ${String(inspection.pluginCount)} installed plugin(s) and ${String(inspection.secretCount)} plugin secret setting(s). Quit official bb before importing.`;
    case "source-running":
      return "Official bb is still running. Quit it completely, then reopen bb Personal to import a consistent profile.";
    case "target-not-empty":
      return "This personal profile already contains data. Import is disabled to avoid overwriting it.";
    case "source-missing":
      return "No official bb profile with a database was found. You can start with a new personal profile.";
    case "same-profile":
      return "The official and personal profile paths resolve to the same directory, so import is disabled.";
  }
}

export function renderPersonalOnboardingHtml(
  inspection: PersonalProfileInspection,
): string {
  const importButton = inspection.canImport
    ? '<button type="button" data-choice="import" data-primary>Import official bb</button>'
    : '<button type="button" disabled>Import unavailable</button>';
  const freshLabel =
    inspection.reason === "target-not-empty"
      ? "Continue personal profile"
      : "Start fresh";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>Welcome to bb Personal</title>
  <style>
${DESKTOP_DIALOG_BASE_CSS}
    body { padding: 24px; }
    h1 { font-size: 19px; margin-bottom: 6px; }
    h2 { font-size: 13px; margin: 18px 0 8px; }
    ul { margin: 0; padding-left: 20px; }
    li { font-size: 12px; line-height: 1.5; margin: 5px 0; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .notice { background: color-mix(in srgb, AccentColor 10%, Canvas); border: 1px solid color-mix(in srgb, AccentColor 30%, transparent); border-radius: 7px; margin-top: 16px; padding: 10px 12px; }
    .notice p { margin: 0; }
    .paths { display: grid; gap: 4px; margin-top: 8px; }
    .paths div { display: grid; font-size: 11px; gap: 8px; grid-template-columns: 58px minmax(0, 1fr); }
    .paths span { color: color-mix(in srgb, CanvasText 55%, transparent); }
    .paths code { overflow-wrap: anywhere; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }
    button[data-primary] { background: AccentColor; border-color: AccentColor; color: AccentColorText; }
    button:disabled { cursor: not-allowed; opacity: 0.45; }
  </style>
</head>
<body>
  <h1>Welcome to bb Personal</h1>
  <p>This is your independent security-focused fork. It can live beside official bb without replacing it.</p>
  <h2>What is different</h2>
  <ul>
    <li>Uses an isolated <code>.bb-personal</code> profile and a separate macOS app identity.</li>
    <li>Standard plugin settings marked <code>secret: true</code> are stored in Keychain with no plaintext fallback.</li>
    <li>The official binary updater is disabled. Updates use conflict check → merge → tests → package → replace, with the previous app kept for rollback.</li>
    <li>Plugins still run as full-trust code. Keychain protects storage, not a secret after a trusted plugin reads it.</li>
  </ul>
  <div class="notice">
    <p>${escapeHtmlText(inspectionMessage(inspection))}</p>
    <div class="paths">
      <div><span>Source</span><code>${escapeHtmlText(inspection.sourceDataDir)}</code></div>
      <div><span>Personal</span><code>${escapeHtmlText(inspection.targetDataDir)}</code></div>
    </div>
  </div>
  <h2>What import copies</h2>
  <p>Projects, threads, UI/app settings, installed plugins, marketplaces, skills, attachments and plugin data are copied from a consistent snapshot. Plugin secret files are written to the personal Keychain namespace, verified, and only then removed from the copied profile.</p>
  <h2>What import deliberately leaves behind</h2>
  <p>Environment variables, custom-agent environment values, server headers, machine credentials, Connect sessions, telemetry identity and the official profile itself are not copied or changed.</p>
  <div class="actions">
    <button type="button" data-choice="quit">Quit</button>
    <button type="button" data-choice="fresh">${freshLabel}</button>
    ${importButton}
  </div>
</body>
</html>`;
}

export function openPersonalOnboardingDialog(
  args: OpenPersonalOnboardingDialogArgs,
): Promise<PersonalOnboardingChoice> {
  const dialogWindow = createDesktopDialogWindow({
    parentWindow: args.parentWindow,
    preloadPath: args.preloadPath,
    title: "Welcome to bb Personal",
    width: 620,
  });
  return new Promise<PersonalOnboardingChoice>((resolvePromise) => {
    let settled = false;
    function finish(choice: PersonalOnboardingChoice): void {
      if (settled) return;
      settled = true;
      ipcMain.removeListener(
        BB_DESKTOP_PERSONAL_ONBOARDING_CHOOSE_CHANNEL,
        handleChoice,
      );
      if (!dialogWindow.isDestroyed()) dialogWindow.close();
      resolvePromise(choice);
    }
    function handleChoice(
      event: { sender: { id: number } },
      payload: unknown,
    ): void {
      if (event.sender.id !== dialogWindow.webContents.id) return;
      const parsed = personalOnboardingChooseRequestSchema.safeParse(payload);
      if (!parsed.success) return;
      if (parsed.data.choice === "import" && !args.inspection.canImport) return;
      finish(parsed.data.choice);
    }
    ipcMain.on(BB_DESKTOP_PERSONAL_ONBOARDING_CHOOSE_CHANNEL, handleChoice);
    dialogWindow.on("closed", () => finish("quit"));
    showDesktopDialogHtml(
      dialogWindow,
      renderPersonalOnboardingHtml(args.inspection),
    );
  });
}

function renderProgressHtml(progress: PersonalImportProgress): string {
  const percent = Math.max(0, Math.min(100, progress.percent));
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>Importing official bb</title>
  <style>
${DESKTOP_DIALOG_BASE_CSS}
    body { padding: 26px; }
    h1 { font-size: 17px; margin-bottom: 8px; }
    .track { background: color-mix(in srgb, CanvasText 12%, transparent); border-radius: 999px; height: 7px; margin: 18px 0 10px; overflow: hidden; }
    .fill { background: AccentColor; height: 100%; width: ${String(percent)}%; }
    .meta { display: flex; justify-content: space-between; }
    .meta span { color: color-mix(in srgb, CanvasText 55%, transparent); font-size: 11px; text-transform: capitalize; }
  </style>
</head>
<body>
  <h1>Importing official bb</h1>
  <p>${escapeHtmlText(progress.detail)}</p>
  <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${String(percent)}"><div class="fill"></div></div>
  <div class="meta"><span>${escapeHtmlText(progress.phase)}</span><span>${String(percent)}%</span></div>
</body>
</html>`;
}

export function openPersonalImportProgressWindow(
  args: OpenPersonalImportProgressArgs,
): PersonalImportProgressWindow {
  const dialogWindow = createDesktopDialogWindow({
    parentWindow: args.parentWindow,
    preloadPath: args.preloadPath,
    title: "Importing official bb",
    width: 500,
  });
  dialogWindow.on("close", (event) => event.preventDefault());
  return {
    close() {
      dialogWindow.removeAllListeners("close");
      if (!dialogWindow.isDestroyed()) dialogWindow.close();
    },
    update(progress) {
      if (!dialogWindow.isDestroyed()) {
        showDesktopDialogHtml(dialogWindow, renderProgressHtml(progress));
      }
    },
  };
}

export function formatPersonalImportReport(
  report: PersonalProfileImportReport,
): string {
  return [
    `Imported entries: ${String(report.importedEntries)}`,
    `Installed plugins found: ${String(report.pluginCount)}`,
    `Secrets moved to Keychain: ${String(report.migratedSecrets)}`,
    `Existing matching Keychain entries reused: ${String(report.resumedSecrets)}`,
    `Unsafe or special paths skipped: ${String(report.skippedUnsafePaths)}`,
    `Connect credential removed from the copy: ${report.connectCredentialRemoved ? "yes" : "not present"}`,
    "",
    "Not imported:",
    ...report.omitted.map((entry) => `• ${entry}`),
    "",
    `Official profile preserved: ${report.sourceDataDir}`,
    `Personal profile: ${report.targetDataDir}`,
  ].join("\n");
}
