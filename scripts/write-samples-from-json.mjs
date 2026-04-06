import fs from "node:fs/promises";
import path from "node:path";
import { writeSampleDataFiles } from "./lib/sample-data-writer.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = args.input;
  if (!inputPath) {
    throw new Error("Missing --input <path-to-json>");
  }

  const projectRoot = process.cwd();
  const absoluteInput = path.isAbsolute(inputPath) ? inputPath : path.join(projectRoot, inputPath);
  const raw = await fs.readFile(absoluteInput, "utf8");
  const payload = JSON.parse(raw);

  const result = await writeSampleDataFiles({
    students: payload.students || [],
    monthlyFees: payload.monthlyFees || [],
    settings: payload.settings || {},
    projectRoot,
    paths: {
      studentsCsv: args["students-out"],
      monthlyFeesCsv: args["monthly-fees-out"],
      settingsCsv: args["settings-out"],
      mockDataJs: args["mock-data-out"],
    },
  });

  console.log(`Students written: ${result.studentsCount}`);
  console.log(`Monthly fee rows: ${result.monthlyFeesCount}`);
  console.log(`Settings rows: ${result.settingsCount}`);
  console.log(`Students CSV: ${result.paths.studentsCsv}`);
  console.log(`MonthlyFees CSV: ${result.paths.monthlyFeesCsv}`);
  console.log(`Settings CSV: ${result.paths.settingsCsv}`);
  console.log(`Mock data: ${result.paths.mockDataJs}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
