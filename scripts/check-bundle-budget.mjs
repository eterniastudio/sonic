import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";

const DIST_DIRECTORY = path.resolve(process.cwd(), process.argv[2] ?? "dist");

// These release gates leave limited, intentional headroom above the v0.2.0
// production baseline documented in README.md and tests/VERIFICATION.md.
const BUDGETS = Object.freeze({
  javascript: Object.freeze({ raw: 440_000, gzip: 125_000 }),
  css: Object.freeze({ raw: 42_000, gzip: 8_500 }),
  total: Object.freeze({ raw: 570_000, gzip: 220_000 }),
});

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function emptyMeasurement() {
  return { files: 0, raw: 0, gzip: 0 };
}

function addMeasurement(measurement, rawBytes, gzipBytes) {
  measurement.files += 1;
  measurement.raw += rawBytes;
  measurement.gzip += gzipBytes;
}

function formatBytes(bytes) {
  return `${bytes.toLocaleString("en-US")} B`;
}

function formatUsage(actual, budget) {
  const percentage = ((actual / budget) * 100).toFixed(1);
  return `${formatBytes(actual)} / ${formatBytes(budget)} (${percentage}%)`;
}

function printRow(label, measurement, budget) {
  console.log(
    `${label.padEnd(12)} ${String(measurement.files).padStart(2)} file${measurement.files === 1 ? " " : "s"}` +
      `  raw ${formatUsage(measurement.raw, budget.raw)}` +
      `  gzip ${formatUsage(measurement.gzip, budget.gzip)}`,
  );
}

async function main() {
  let files;
  try {
    files = await collectFiles(DIST_DIRECTORY);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`Production output not found at ${DIST_DIRECTORY}. Run npm run build first.`);
    }
    throw error;
  }

  if (files.length === 0) {
    throw new Error(`Production output at ${DIST_DIRECTORY} is empty. Run npm run build first.`);
  }

  const measurements = {
    javascript: emptyMeasurement(),
    css: emptyMeasurement(),
    total: emptyMeasurement(),
  };

  for (const file of files.sort()) {
    const buffer = await readFile(file);
    const extension = path.extname(file).toLowerCase();
    const rawBytes = buffer.byteLength;
    const gzipBytes = gzipSync(buffer).byteLength;

    addMeasurement(measurements.total, rawBytes, gzipBytes);
    if (extension === ".js" || extension === ".mjs") {
      addMeasurement(measurements.javascript, rawBytes, gzipBytes);
    } else if (extension === ".css") {
      addMeasurement(measurements.css, rawBytes, gzipBytes);
    }
  }

  if (measurements.javascript.files === 0 || measurements.css.files === 0) {
    throw new Error("Production output must contain at least one JavaScript file and one CSS file.");
  }

  console.log(`Sonic frontend bundle budget (${path.relative(process.cwd(), DIST_DIRECTORY) || "."})`);
  printRow("JavaScript", measurements.javascript, BUDGETS.javascript);
  printRow("CSS", measurements.css, BUDGETS.css);
  printRow("All static", measurements.total, BUDGETS.total);

  const exceeded = [];
  for (const [category, measurement] of Object.entries(measurements)) {
    for (const encoding of ["raw", "gzip"]) {
      const budget = BUDGETS[category][encoding];
      const actual = measurement[encoding];
      if (actual > budget) {
        exceeded.push(
          `${category} ${encoding}: ${formatBytes(actual)} exceeds ${formatBytes(budget)} by ${formatBytes(actual - budget)}`,
        );
      }
    }
  }

  if (exceeded.length > 0) {
    console.error("Bundle budget failed:");
    for (const failure of exceeded) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Bundle budget passed.");
}

main().catch((error) => {
  console.error(`Bundle budget check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
