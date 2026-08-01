/** @type {import('next').NextConfig} */
const nextConfig = {
  // mjml and juice are CommonJS with dynamic requires; keep them out of the
  // bundler and let Node resolve them at runtime.
  serverExternalPackages: ['mjml', 'juice', 'mongodb'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
