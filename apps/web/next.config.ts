import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  transpilePackages: ["@kitty/money", "@kitty/api-client"],
  poweredByHeader: false,
};

export default config;
