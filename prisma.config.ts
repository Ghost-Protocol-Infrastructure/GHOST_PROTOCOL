import { defineConfig } from "prisma/config";
import { bootstrapPostgresEnv } from "./lib/postgres-env";

bootstrapPostgresEnv({ normalizeDirectUrl: false });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
});
