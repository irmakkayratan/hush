import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const files = [
  "base.sql", "create-team.sql", "save-notion-connection.sql", "notion-management.sql",
  "notion-refresh.sql", "team-invites.sql", "notion-delivery.sql", "reminders.sql",
];
const directory = fileURLToPath(new URL("../supabase/", import.meta.url));
for (const file of files) {
  const sql = await readFile(join(directory, file), "utf8");
  process.stdout.write(`\n-- ${file}\n${sql}\n`);
}
