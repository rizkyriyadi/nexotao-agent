/** @type {import('next').NextConfig} */
const nextConfig = {
  // keep the production server self-contained so `nexotao` just works after install
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
