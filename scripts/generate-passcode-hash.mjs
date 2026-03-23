import { pbkdf2Sync, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const rl = createInterface({ input, output });

async function main() {
  const passcode = await rl.question("Enter passcode: ");
  const confirm = await rl.question("Confirm passcode: ");
  rl.close();

  if (!passcode || passcode !== confirm) {
    throw new Error("Passcodes do not match.");
  }

  const iterations = 120000;
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(passcode, salt, iterations, 32, "sha256").toString("hex");
  const encoded = `pbkdf2$${iterations}$${salt}$${hash}`;

  output.write("\nSet this in Vercel as PASSCODE_HASH:\n");
  output.write(`${encoded}\n`);
}

main().catch((error) => {
  output.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
});

