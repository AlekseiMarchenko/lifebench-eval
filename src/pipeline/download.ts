import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_URL = "https://github.com/1754955896/LifeBench.git";
const DATA_SUBDIR = "life_bench_data/data_en";

/**
 * Download LifeBench data via sparse git checkout (only data_en/).
 * If already present, skip.
 */
export function downloadLifeBenchData(dataDir: string): string[] {
  const targetDir = join(dataDir, "lifebench-repo");
  const dataPath = join(targetDir, DATA_SUBDIR);

  if (existsSync(dataPath)) {
    console.log(`LifeBench data already present at ${dataPath}`);
  } else {
    console.log("Downloading LifeBench data from GitHub...");
    execSync(
      `git clone --depth 1 --filter=blob:none --sparse ${REPO_URL} "${targetDir}"`,
      { stdio: "inherit" }
    );
    execSync(`git -C "${targetDir}" sparse-checkout set "${DATA_SUBDIR}"`, {
      stdio: "inherit",
    });
    console.log("Download complete.");
  }

  // Return list of user directories
  const users = readdirSync(dataPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  console.log(`Found ${users.length} users: ${users.join(", ")}`);
  return users;
}

/**
 * Get the path to a specific user's data directory.
 */
export function getUserDataPath(dataDir: string, userId: string): string {
  return join(dataDir, "lifebench-repo", DATA_SUBDIR, userId);
}
