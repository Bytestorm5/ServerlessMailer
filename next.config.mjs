/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `mjml` is a CommonJS package that resolves templates at runtime; keeping it
  // external stops the bundler from trying to statically analyse its requires.
  serverExternalPackages: ['mjml', 'mongodb'],
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
