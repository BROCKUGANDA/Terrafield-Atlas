import type { NextConfig } from "next";

/**
 * Production hardening headers. CSP is deliberately NOT set at the Next layer:
 * the console uses Next's inline flight/bootstrap scripts, which need a nonce
 * strategy; an incomplete CSP here would break serving (the one unacceptable
 * failure mode). The frame/nosniff/referrer/permission set below is applied
 * globally; TLS termination adds HSTS at the gateway.
 */
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
    ];
  },
  reactStrictMode: false,
};

export default nextConfig;
