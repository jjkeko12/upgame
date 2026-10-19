import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (see Dockerfile)
  output: "standalone",
  poweredByHeader: false,
  // Node packages that must not be bundled
  serverExternalPackages: ["yauzl"],
};

export default nextConfig;
