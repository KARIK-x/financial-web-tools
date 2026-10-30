import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

async function main() {
  const from = process.argv.find((a) => a.startsWith("--from="))?.split("=")[1];
  const out = process.argv.find((a) => a.startsWith("--out="))?.split("=")[1];
  const passphrase = process.env.BACKUP_PASSPHRASE;
  if (!from || !out) throw new Error("Usage: npm run backups:encrypt -- --from=<backup-dir> --out=<file.tar.gz.enc>");
  if (!passphrase) throw new Error("Set BACKUP_PASSPHRASE in the environment; do not put it on the command line.");
  const archive = out.endsWith(".enc") ? out.slice(0, -4) : `${out}.tar.gz`;
  execFileSync("tar", ["-czf", archive, "-C", path.dirname(from), path.basename(from)], { stdio: "inherit" });
  execFileSync("openssl", ["enc", "-aes-256-cbc", "-salt", "-pbkdf2", "-in", archive, "-out", out, "-pass", `env:BACKUP_PASSPHRASE`], {
    stdio: "inherit",
    env: { ...process.env, BACKUP_PASSPHRASE: passphrase },
  });
  await fs.rm(archive, { force: true });
  console.log(`Encrypted backup written to ${out}.`);
  console.log("Store the passphrase in a secret manager, not in the repository.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
