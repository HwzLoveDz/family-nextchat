/* eslint-disable @next/next/no-page-custom-font */
import "./styles/globals.scss";
import "./styles/markdown.scss";
import "./styles/highlight.scss";
import { getClientConfig } from "./config/client";
import type { Metadata, Viewport } from "next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { GoogleTagManager, GoogleAnalytics } from "@next/third-parties/google";
import { getServerSideConfig } from "./config/server";
import { headers } from "next/headers";
import { isFamilyMode } from "./family/enabled";

export const metadata: Metadata = {
  title: isFamilyMode() ? "Harvey 家庭 AI" : "NextChat",
  description: isFamilyMode()
    ? "家人专用的 AI 助手。"
    : "Your personal AI assistant.",
  appleWebApp: {
    title: "NextChat",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#151515" },
  ],
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const familyMode = isFamilyMode();
  // Nonces require per-request rendering. Do not evaluate legacy configuration
  // or mount its scripts in the isolated family application.
  if (familyMode) await headers();
  const serverConfig = familyMode ? null : getServerSideConfig();

  return (
    <html lang={familyMode ? "zh-CN" : "en"}>
      <head>
        {!familyMode && (
          <>
            <meta name="config" content={JSON.stringify(getClientConfig())} />
            <link
              rel="manifest"
              href="/site.webmanifest"
              crossOrigin="use-credentials"
            />
            <script src="/serviceWorkerRegister.js" defer />
          </>
        )}
      </head>
      <body>
        {children}
        {serverConfig?.isVercel && (
          <>
            <SpeedInsights />
          </>
        )}
        {serverConfig?.gtmId && (
          <>
            <GoogleTagManager gtmId={serverConfig.gtmId} />
          </>
        )}
        {serverConfig?.gaId && (
          <>
            <GoogleAnalytics gaId={serverConfig.gaId} />
          </>
        )}
      </body>
    </html>
  );
}
