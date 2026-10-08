import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
const cwd = process.cwd();
mkdirSync(".sites-runtime", { recursive: true });
const config = path.join(cwd, ".sites-runtime/local-d1.json");
writeFileSync(
  config,
  JSON.stringify(
    {
      name: "xbuddy-local",
      compatibility_date: "2026-05-15",
      d1_databases: [
        {
          binding: "DB",
          database_name: "site-creator-d1",
          database_id: "00000000-0000-4000-8000-000000000000",
          migrations_dir: path.join(cwd, "drizzle"),
        },
      ],
    },
    null,
    2,
  ),
);
const result = spawnSync(
  process.execPath,
  [
    "--import",
    "./scripts/sites-env.mjs",
    "./node_modules/wrangler/bin/wrangler.js",
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--config",
    config,
    "--persist-to",
    path.join(cwd, ".wrangler/state"),
  ],
  { stdio: "inherit", env: { ...process.env, CI: "1" } },
);
process.exit(result.status ?? 1);
