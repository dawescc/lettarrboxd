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

  const summary: string[] = [];

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
  let version = pkg.version;

  note(`Current Version: ${version}`, "Info");

  // 0. release Mode Support
  const releaseMode = await select({
    message: "Release Mode:",
    options: [
      { value: "new", label: "New Release", hint: "Bump version & create new tag" },
      { value: "amend", label: "Roll-in (Amend)", hint: "Update last release (force push)" },
    ]
  });
  checkCancel(releaseMode);
  const isAmend = releaseMode === "amend";

  // 1. Version Bump (Skip if Amending)
  if (!isAmend) {
    const shouldBump = await confirm({
      message: "Do you want to bump the version?",
      initialValue: false,
    });
    checkCancel(shouldBump);
    const bump = Boolean(shouldBump);

    if (bump) {
      const [major, minor, patchStr] = version.split(".");
      const patch = parseInt(patchStr, 10);
      const nextPatch = !isNaN(patch) ? `${major}.${minor}.${patch + 1}` : version;

      const newVersionInput = await text({
        message: "Enter new version:",
        placeholder: nextPatch,
      });
      checkCancel(newVersionInput);

      const versionString = String(newVersionInput) || nextPatch;

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
      summary.push(`Bumped version from ${pkg.version} to ${versionString}`);
    }
  } else {
    note(`Staying on version ${version} (Amend Mode)`, "Info");
  }

  // 3. Channel Selection
  // We ask this early to determine if we need to append a pre-release suffix (e.g. -nightly)
  // which affects both the commit title default and the git tag.

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
    // Construct the full release version (e.g. 2.6.8-nightly) for usage in:
    // 1. Git Tag
    // 2. Docker Image Tag
    // Note: We do not update package.json with this strictly transient suffix to avoid noise.

    // Let's modify the local variable `releaseVersion` to be used for Git Tag and Docker Image Tag.
    releaseVersion = `${version}-${selectedChannel}`;
    note(`Pre-release detected. Will tag as: v${releaseVersion}`, "SemVer");
  }

  // 2. Commit & Tag
  const shouldCommit = await confirm({
    message: isAmend ? "Update last commit (Amend)?" : "Create local git commit?",
    initialValue: true,
  });
  checkCancel(shouldCommit);

  let tagged = false;

  if (shouldCommit) {
    let commitMsg = "";

    if (isAmend) {
      // For Amend: Ask if they want to edit the message or keep it
      const editMsg = await confirm({
        message: "Edit commit message?",
        initialValue: false
      });
      checkCancel(editMsg);

      if (!editMsg) {
        const s = spinner();
        s.start("Amending commit...");
        await run("git", ["add", "."], s);
        await run("git", ["commit", "--amend", "--no-edit"], s);
        s.stop("Amended commit (no edit)");
        summary.push("Amended last commit (no message change)");

        // Branch out to avoid running the full wizard
        // But we still need to handle tagging below
        commitMsg = "(Amended)"; // placeholder
      } else {
        // If editing, fall through to wizard but modify final command
      }
    }

    // If NOT amending OR (Amending AND Editing), run wizard
    if (!isAmend || (isAmend && commitMsg === "")) {
      const commitType = await select({
        message: "Commit Type:",
        options: [
          { value: "chore", label: "chore", hint: "Build/Auxiliary" },
          { value: "feat", label: "feat", hint: "New Feature" },
          { value: "fix", label: "fix", hint: "Bug Fix" },
          { value: "refactor", label: "refactor", hint: "Code Change" },
          { value: "docs", label: "docs", hint: "Documentation" },
          { value: "style", label: "style", hint: "Formatting" },
          { value: "perf", label: "perf", hint: "Performance" },
          { value: "test", label: "test", hint: "Tests" },
          { value: "ci", label: "ci", hint: "CI Config" },
        ],
      });
      checkCancel(commitType);
      const typeStr = String(commitType);

      const defaultTitle = `release v${releaseVersion}`;
      const commitTitleInput = await text({
        message: "Commit Title:",
        placeholder: defaultTitle,
      });
      checkCancel(commitTitleInput);

      const commitTitle = String(commitTitleInput) || defaultTitle;

      // Description Loop
      const lines: string[] = [];

      // Initial check
      let addLine = await confirm({
        message: "Add description items (bullet points)?",
        initialValue: false,
      });
      checkCancel(addLine);
      let adding = Boolean(addLine);

      while (adding) {
        const lineInput = await text({
          message: "Enter Item:",
          placeholder: "e.g. Added new feature",
        });
        checkCancel(lineInput);

        const lineStr = String(lineInput);
        if (lineStr) {
          lines.push(`- ${lineStr}`);
        }

        addLine = await confirm({
          message: "Add another item?",
          initialValue: true,
        });
        checkCancel(addLine);
        adding = Boolean(addLine);
      }

      const description = lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
      const commitMsg = `${typeStr}: ${commitTitle}${description}`;

      // Tag Decision
      const shouldTag = await confirm({
        message: isAmend ? `Force update tag v${releaseVersion}?` : `Also tag this commit as v${releaseVersion}?`,
        initialValue: true
      });
      checkCancel(shouldTag);

      const s = spinner();

      if (isAmend && commitMsg === "(Amended)") {
        // Verify we don't double commit, we already did it above
      } else {
        const op = isAmend ? "Amending..." : "Committing...";
        s.start(op);
        await run("git", ["add", "."], s);

        if (isAmend) {
          await run("git", ["commit", "--amend", "-m", commitMsg], s);
        } else {
          await run("git", ["commit", "-m", commitMsg], s);
        }
      }

      if (shouldTag) {
        const tagOp = isAmend ? `Force updating tag v${releaseVersion}...` : `Tagging v${releaseVersion}...`;
        s.message(tagOp);

        if (isAmend) {
          await run("git", ["tag", "-f", `v${releaseVersion}`], s);
        } else {
          await run("git", ["tag", `v${releaseVersion}`], s);
        }
        tagged = true;
      }
      s.stop("Git operations complete");
      summary.push(`Created commit "${commitMsg}"`);
      if (tagged) summary.push(`Tagged v${releaseVersion} locally`);
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

      // Get Commit SHA for OCI Labels
      const shaProc = spawn({ cmd: ["git", "rev-parse", "HEAD"], stdout: "pipe" });
      const sha = await new Response(shaProc.stdout).text();
      const cleanSha = sha.trim();

      await run("docker", ["buildx", "build",
        "--platform", "linux/amd64,linux/arm64",
        "--push",
        "--build-arg", `COMMIT_SHA=${cleanSha}`,
        "--annotation", "index:org.opencontainers.image.description=Automatically add movies and series from Letterboxd and Serializd to Radarr and Sonarr.",
        "--tag", `ghcr.io/dawescc/lettarrboxd:${releaseVersion}`, // Specific (e.g. 2.6.6-nightly)
        "--tag", `ghcr.io/dawescc/lettarrboxd:${selectedChannel}`, // Floating (e.g. nightly)
        "."
      ], s);

      s.stop("Build & Push complete!");
      summary.push(`Built and pushed Docker images (tags: v${releaseVersion}, ${selectedChannel})`);
    }

    // 5. Git Push
    let pushMsg = isAmend ? "Force push commits to remote?" : "Push commits to remote?";
    if (tagged) {
      pushMsg = isAmend
        ? `Force push tag (v${releaseVersion}) and commits?`
        : `Push git tag (v${releaseVersion}) and commits?`;
    }

    const shouldPushGit = await confirm({
      message: pushMsg,
      initialValue: true,
    });
    checkCancel(shouldPushGit);

    if (shouldPushGit) {
      const s = spinner();
      s.start("Pushing to origin...");

      const pushFlags = isAmend ? ["push", "--force"] : ["push"];
      await run("git", pushFlags, s);

      if (tagged) {
        // If force pushing tags needed
        const tagFlags = isAmend ? ["push", "--tags", "--force"] : ["push", "--tags"];
        await run("git", tagFlags, s);
      }
      s.stop("Git sync complete");
      summary.push("Pushed commits to origin");
      if (tagged) summary.push(`Pushed tag v${releaseVersion} to origin`);
    }

    if (IS_DRY_RUN) {
      note(summary.map(s => `[DRY RUN] ${s}`).join("\n"), "Dry Run Summary");
    } else {
      note(summary.join("\n"), "Release Summary");
    }

    outro(`Release v${releaseVersion} completed successfully! 🎉`);
  }
}

main().catch(console.error);
