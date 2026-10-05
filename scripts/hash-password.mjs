import { createInterface } from "node:readline/promises";
import { hashPassword } from "../lib/auth.ts";

// Read from stdin so the password never appears in shell history or process arguments.
if (process.stdin.isTTY) {
  process.stderr.write("Supply a password over stdin; do not put credentials in command arguments.\nExample: read -s 'password?Password: '; printf '%s' \"$password\" | node --experimental-strip-types scripts/hash-password.mjs; unset password\n");
  process.exitCode = 1;
} else {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let password = "";
  for await (const line of input) {
    password += line;
    if (password.length > 256) break;
  }
  try { process.stdout.write(`${await hashPassword(password)}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
