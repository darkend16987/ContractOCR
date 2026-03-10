/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  webpack: (config) => {
    // pdfjs-dist needs canvas alias to false for SSR
    config.resolve.alias.canvas = false;
    return config;
  },
};

export default nextConfig;
