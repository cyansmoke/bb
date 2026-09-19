import {
  createBbDesktopVersionFeedFileName,
  type BbDesktopVersionFeedPlatform,
} from "@bb/desktop-contract";

export type DesktopReleaseChannel = "latest" | "nightly" | "personal";

interface DesktopReleaseInfo {
  applicationName: "bb" | "bb Nightly" | "bb Personal";
  channel: DesktopReleaseChannel;
  iconFileName: "icon.png" | "icon-nightly.png";
  releaseTag: "desktop-latest" | "desktop-nightly" | "desktop-personal";
  updateReleaseBaseUrl: string;
}

export function createDesktopReleaseInfo(
  channel: DesktopReleaseChannel,
): DesktopReleaseInfo {
  if (channel === "personal") {
    return {
      applicationName: "bb Personal",
      channel,
      iconFileName: "icon.png",
      releaseTag: "desktop-personal",
      updateReleaseBaseUrl:
        "https://github.com/cyansmoke/bb/releases/download/desktop-personal/",
    };
  }
  const nightly = channel === "nightly";
  const releaseTag = nightly ? "desktop-nightly" : "desktop-latest";

  return {
    applicationName: nightly ? "bb Nightly" : "bb",
    channel,
    iconFileName: nightly ? "icon-nightly.png" : "icon.png",
    releaseTag,
    updateReleaseBaseUrl: `https://github.com/get-bb/bb/releases/download/${releaseTag}/`,
  };
}

function resolveBuiltDesktopReleaseChannel(
  rawChannel: string | undefined,
): DesktopReleaseChannel {
  if (rawChannel === undefined || rawChannel.length === 0) {
    return "latest";
  }
  if (
    rawChannel === "latest" ||
    rawChannel === "nightly" ||
    rawChannel === "personal"
  ) {
    return rawChannel;
  }

  throw new Error(
    `Built desktop release channel must be latest, nightly, or personal, got ${String(rawChannel)}.`,
  );
}

export const DESKTOP_RELEASE_CHANNEL = resolveBuiltDesktopReleaseChannel(
  process.env.BB_DESKTOP_RELEASE_CHANNEL,
);
export const DESKTOP_RELEASE_INFO = createDesktopReleaseInfo(
  DESKTOP_RELEASE_CHANNEL,
);
const DESKTOP_UPDATE_RELEASE_BASE_URL =
  DESKTOP_RELEASE_INFO.updateReleaseBaseUrl;

export function createDesktopUpdateFeedUrl(
  platform: BbDesktopVersionFeedPlatform,
): string {
  return `${DESKTOP_UPDATE_RELEASE_BASE_URL}${createBbDesktopVersionFeedFileName(platform)}`;
}

export interface DesktopAutoUpdateFeedConfig {
  channel: DesktopReleaseChannel;
  provider: "generic";
  url: string;
}

export const DESKTOP_AUTO_UPDATE_FEED_CONFIG: DesktopAutoUpdateFeedConfig = {
  channel: DESKTOP_RELEASE_CHANNEL,
  provider: "generic",
  url: DESKTOP_UPDATE_RELEASE_BASE_URL,
};

interface DesktopUpdateSupport {
  autoUpdate: boolean;
  versionCheck: boolean;
}

interface ResolveDesktopUpdateSupportArgs {
  canReplaceAppImage: (appImagePath: string) => boolean;
  env: NodeJS.ProcessEnv;
  platform: BbDesktopVersionFeedPlatform;
}

export function resolveDesktopUpdateSupport(
  args: ResolveDesktopUpdateSupportArgs,
): DesktopUpdateSupport {
  if (DESKTOP_RELEASE_CHANNEL === "personal") {
    return { autoUpdate: false, versionCheck: false };
  }
  if (args.platform === "macos") {
    return { autoUpdate: true, versionCheck: true };
  }

  const appImagePath = args.env.APPIMAGE?.trim() ?? "";
  if (appImagePath.length === 0) {
    return { autoUpdate: false, versionCheck: true };
  }

  return {
    autoUpdate: args.canReplaceAppImage(appImagePath),
    versionCheck: true,
  };
}
