import webpack from "webpack";

const mode = process.env.BUILD_MODE ?? "standalone";
const familyMode =
  process.env.NODE_ENV === "production" || process.env.FAMILY_MODE === "1";
console.log("[Next] build mode", mode);

const disableChunk = !!process.env.DISABLE_CHUNK || mode === "export";
console.log("[Next] build with chunk: ", !disableChunk);

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // Keep ws optional native dependencies under Node's normal require fallback.
  serverExternalPackages: ["ws"],
  webpack(config) {
    config.module.rules.push({
      test: /\.svg$/,
      use: ["@svgr/webpack"],
    });

    if (disableChunk) {
      config.plugins.push(
        new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
      );
    }

    config.resolve.fallback = {
      child_process: false,
    };

    return config;
  },
  output: mode,
  images: {
    unoptimized: mode === "export",
  },
};

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=()",
  },
];

if (mode !== "export") {
  nextConfig.headers = async () => {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "CDN-Cache-Control", value: "no-store" },
          { key: "Vercel-CDN-Cache-Control", value: "no-store" },
        ],
      },
      {
        source: "/serviceWorker.js",
        headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }],
      },
    ];
  };

  nextConfig.rewrites = async () => {
    const ret = familyMode
      ? []
      : [
          {
            source: "/google-fonts/:path*",
            destination: "https://fonts.googleapis.com/:path*",
          },
          {
            source: "/sharegpt",
            destination: "https://sharegpt.com/api/conversations",
          },
        ];

    return {
      beforeFiles: ret,
    };
  };
}

export default nextConfig;
