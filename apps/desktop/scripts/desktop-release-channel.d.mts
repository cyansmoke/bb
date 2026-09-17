export type DesktopReleaseChannel = "latest" | "nightly" | "personal";
export type DesktopBuildPlatform = "macos" | "linux";

export interface DesktopUpdateMetadataFileNames {
  linux: "latest-linux.yml" | "nightly-linux.yml" | "personal-linux.yml";
  macos: "latest-mac.yml" | "nightly-mac.yml" | "personal-mac.yml";
}

export interface DesktopReleaseConfig {
  appId:
    | "dev.bb.desktop"
    | "dev.bb.desktop.nightly"
    | "dev.bb.desktop.personal";
  applicationName: "bb" | "bb Nightly" | "bb Personal";
  artifactName: string;
  iconFileName: "icon.png" | "icon-nightly.png";
  linuxExecutableName: "bb" | "bb-nightly" | "bb-personal";
  macIconPath: "assets/icon.icns" | "assets/icon-nightly.icns";
  releaseTag: "desktop-latest" | "desktop-nightly" | "desktop-personal";
  updateMetadataFileNames: DesktopUpdateMetadataFileNames;
}

export function resolveDesktopReleaseChannel(
  env: NodeJS.ProcessEnv,
): DesktopReleaseChannel;

export function resolveDesktopBuildPlatform(
  nodePlatform: string,
): DesktopBuildPlatform;

export function createDesktopReleaseConfig(
  channel: DesktopReleaseChannel,
): DesktopReleaseConfig;

export function createDesktopUpdateReleaseBaseUrl(
  releaseTag: DesktopReleaseConfig["releaseTag"],
): string;
