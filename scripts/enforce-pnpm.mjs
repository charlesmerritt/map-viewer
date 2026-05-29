#!/usr/bin/env node

const userAgent = process.env.npm_config_user_agent || "";

if (!userAgent || userAgent.startsWith("pnpm/")) {
  process.exit(0);
}

console.error("This project uses pnpm. Run `pnpm install` instead of npm/yarn.");
process.exit(1);
