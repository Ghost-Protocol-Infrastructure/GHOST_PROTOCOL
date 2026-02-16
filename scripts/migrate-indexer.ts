import { execSync } from "node:child_process";

execSync("npx prisma db push", {
  stdio: "inherit",
});
