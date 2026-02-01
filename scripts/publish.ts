import { spawn } from "bun";
import fs from "fs";
import path from "path";
import {
  intro,
  outro,
  text,
  select,
  confirm,
  spinner,
  isCancel,
  cancel,
  note,
} from "@clack/prompts";

// Configuration
const PKG_PATH = path.join(process.cwd(), "package.json");
const DOCKERFILE_PATH = path.join(process.cwd(), "Dockerfile");
const IS_DRY_RUN = process.argv.includes("--dry-run");

// Helper: Handle Cancellation
function checkCancel(value: unknown) {
  if (isCancel(value)) {
    cancel("Operation cancelled.");
    process.exit(0);
  }
}

// Helper: Run Command
async function run(cmd: string, args: string[], s?: ReturnType<typeof spinner>) {
  const fullCmd = `${cmd} ${args.join(" ")}`;
  
  if (IS_DRY_RUN) {
    if (s) s.message(`[DRY RUN] Would execute: ${fullCmd}`);
    else console.log(`[DRY RUN] Would execute: ${fullCmd}`);
    return;
  }

  const p = spawn({
    cmd: [cmd, ...args],
    stdout: "ignore", // Keep it clean for the spinner, unless we want logs
    stderr: "inherit",
  });

  const exitCode = await p.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed: ${fullCmd}`);
  }
}

// Helper: Write File
async function writeFile(filePath: string, content: string) {
  if (IS_DRY_RUN) {
    console.log(`[DRY RUN] Would write to ${path.basename(filePath)}`);
    return;
  }
  fs.writeFileSync(filePath, content);
}

// MAIN
async function main() {
  console.clear();
  intro(`🚀 Lettarrboxd Release CLI ${IS_DRY_RUN ? "(DRY RUN)" : ""}`);

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
  let version = pkg.version;

  note(`Current Version: ${version}`, "Info");

  // 1. Version Bump
  const shouldBump = await confirm({
    message: "Do you want to bump the version?",
    initialValue: false,
  });
  checkCancel(shouldBump);

  if (shouldBump) {
    const [major, minor, patch] = version.split(".").map(Number);
    const nextPatch = !isNaN(patch) ? `${major}.${minor}.${patch + 1}` : version;

    const newVersion = await text({
      message: "Enter new version:",
      placeholder: `e.g. ${nextPatch}`,
      validate(value) {
        if (!value) return "Version is required";
      },
    });
    checkCancel(newVersion);

    const versionString = String(newVersion);

    // Write updates
    const s = spinner();
    s.start("Updating files...");
    
    // Update package.json
    pkg.version = versionString;
    await writeFile(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");
    
    // Update Dockerfile
    let dockerfile = fs.readFileSync(DOCKERFILE_PATH, "utf8");
    const versionRegex = /LABEL org.opencontainers.image.version="([^"]+)"/;
    if (dockerfile.match(versionRegex)) {
      dockerfile = dockerfile.replace(versionRegex, `LABEL org.opencontainers.image.version="${versionString}"`);
      await writeFile(DOCKERFILE_PATH, dockerfile);
    }
    s.stop(`Bumped to ${versionString}`);
    version = versionString;
  }

  // 2. Commit
  const shouldCommit = await confirm({
    message: `Create local commit "chore: release v${version}"?`,
    initialValue: true,
  });
  checkCancel(shouldCommit);

  if (shouldCommit) {
    const s = spinner();
    s.start("Committing changes...");
    await run("git", ["add", "."], s);
    await run("git", ["commit", "-m", `chore: release v${version}`], s);
    s.stop("Changes committed");
  }

  // 3. Channel
  const channel = await select({
    message: "Select Release Channel:",
    options: [
      { value: "latest", label: "Latest (Stable)", hint: "Prod" },
      { value: "nightly", label: "Nightly (Dev)", hint: "Beta/Dev" },
      { value: "beta", label: "Beta", hint: "Testing" },
    ],
  });
  checkCancel(channel);

  const selectedChannel = String(channel);

  // SemVer Pre-release Logic
  let releaseVersion = version;
  if (selectedChannel !== "latest" && !version.includes(`-${selectedChannel}`)) {
     // If user didn't already type "2.6.6-nightly" manually, we append it for the tag context
     // But we do NOT update package.json with this ephemeral tag usually, 
     // unless the user specifically wants the package.json to say "2.6.6-nightly".
     // For this workflow, let's treat `releaseVersion` as the Git/Docker tag, keeping package.json clean-ish 
     // OR update it if that's the preference. The user said "include that in the Version Tag itself".
     
     // Let's modify the local variable `releaseVersion` to be used for Git Tag and Docker Image Tag.
     releaseVersion = `${version}-${selectedChannel}`;
     note(`Pre-release detected. Will tag as: v${releaseVersion}`, "SemVer");
  }

  // 4. Build & Push
  const shouldBuild = await confirm({
    message: `Build & Push to GHCR? (v${releaseVersion} + ${selectedChannel})`,
    initialValue: true,
  });
  checkCancel(shouldBuild);

  if (shouldBuild) {
    const s = spinner();
    s.start("Building multi-arch images (this may take a while)...");
    
    // Ensure builder (lazy)
    if (!IS_DRY_RUN) {
        try {
            const check = spawn({ cmd: ["docker", "buildx", "inspect", "mybuilder"], stdout: "ignore", stderr: "ignore" });
            if ((await check.exited) !== 0) throw new Error();
            await run("docker", ["buildx", "use", "mybuilder"]);
        } catch {
            await run("docker", ["buildx", "create", "--use", "--name", "mybuilder"]);
        }
    }

    await run("docker", ["buildx", "build", 
        "--platform", "linux/amd64,linux/arm64",
        "--push",
        "--tag", `ghcr.io/dawescc/lettarrboxd:${releaseVersion}`, // Specific (e.g. 2.6.6-nightly)
        "--tag", `ghcr.io/dawescc/lettarrboxd:${selectedChannel}`, // Floating (e.g. nightly)
        "."
    ], s);
    
    s.stop("Build & Push complete!");
  }

  // 5. Git Tags
  const shouldPushGit = await confirm({
    message: `Push git tag (v${releaseVersion}) and commits?`,
    initialValue: true,
  });
  checkCancel(shouldPushGit);

  if (shouldPushGit) {
    const s = spinner();
    s.start("Pushing to origin...");
    await run("git", ["tag", `v${releaseVersion}`], s);
    await run("git", ["push"], s);
    await run("git", ["push", "--tags"], s);
    s.stop("Git sync complete");
  }

  outro(`Release v${releaseVersion} completed successfully! 🎉`);
}

main().catch(console.error);
