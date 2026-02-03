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
    stdout: "ignore",
    stderr: "inherit",
  });

  const exitCode = await p.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed: ${fullCmd}`);
  }
}

// Helper: Run Command with Output (read-only queries - always run, even in dry-run)
async function runWithOutput(cmd: string, args: string[]): Promise<string> {
  const p = spawn({
    cmd: [cmd, ...args],
    stdout: "pipe",
    stderr: "ignore",
  });

  const output = await new Response(p.stdout).text();
  return output.trim();
}

// Helper: Write File
async function writeFile(filePath: string, content: string) {
  if (IS_DRY_RUN) {
    console.log(`[DRY RUN] Would write to ${path.basename(filePath)}`);
    return;
  }
  fs.writeFileSync(filePath, content);
}

// Helper: Get current HEAD SHA
async function getHeadSha(): Promise<string> {
  return runWithOutput("git", ["rev-parse", "HEAD"]);
}

// Helper: Get tags pointing to a specific commit
async function getTagsOnCommit(sha: string): Promise<string[]> {
  if (!sha) return [];
  const output = await runWithOutput("git", ["tag", "--points-at", sha]);
  if (!output) return [];
  return output.split("\n").filter(Boolean);
}

// Helper: Parse tag to extract version and channel
function parseTag(tag: string): { version: string; channel: string } | null {
  // Expected format: v1.2.3 or v1.2.3.4-channel (supports any number of version segments)
  const match = tag.match(/^v?([\d.]+)(?:-(.+))?$/);
  if (!match) return null;
  return {
    version: match[1],
    channel: match[2] || "latest",
  };
}

// MAIN
async function main() {
  console.clear();
  intro(`🚀 Lettarrboxd Release CLI ${IS_DRY_RUN ? "(DRY RUN)" : ""}`);

  const summary: string[] = [];
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
  let version = pkg.version;

  note(`Current Version: ${version}`, "Info");

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 1: Release Mode
  // ═══════════════════════════════════════════════════════════════════
  const releaseMode = await select({
    message: "Release Mode:",
    options: [
      { value: "new", label: "New Release", hint: "Bump version & create new tag" },
      { value: "amend", label: "Roll-in (Amend)", hint: "Update last release (force push)" },
    ]
  });
  checkCancel(releaseMode);
  const isAmend = releaseMode === "amend";

  // State for amend flow
  let oldCommitSha = "";
  let existingTags: string[] = [];
  let inheritedChannel = "";
  let inheritedVersion = "";

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 2: Amend Detection (capture old state before any changes)
  // ═══════════════════════════════════════════════════════════════════
  if (isAmend) {
    oldCommitSha = await getHeadSha();
    existingTags = await getTagsOnCommit(oldCommitSha);

    if (existingTags.length > 0) {
      // Parse the first tag to inherit version/channel
      const parsed = parseTag(existingTags[0]);
      if (parsed) {
        inheritedVersion = parsed.version;
        inheritedChannel = parsed.channel;
        note(
          `Found existing tag: ${existingTags[0]}\n` +
          `Will inherit: version=${inheritedVersion}, channel=${inheritedChannel}`,
          "Amend Detection"
        );
      }
    } else {
      note("No existing tags found on last commit.", "Amend Detection");
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 3: Version Bump (New Release only)
  // ═══════════════════════════════════════════════════════════════════
  if (!isAmend) {
    const shouldBump = await confirm({
      message: "Do you want to bump the version?",
      initialValue: false,
    });
    checkCancel(shouldBump);

    if (shouldBump) {
      // Increment the LAST segment of the version (e.g., 2.7.2 → 2.7.3, 2.7.2.1 → 2.7.2.2)
      const parts = version.split(".");
      const lastIdx = parts.length - 1;
      const lastPart = parseInt(parts[lastIdx], 10);
      const nextVersion = !isNaN(lastPart)
        ? [...parts.slice(0, lastIdx), lastPart + 1].join(".")
        : version;

      const newVersionInput = await text({
        message: "Enter new version:",
        placeholder: nextVersion,
      });
      checkCancel(newVersionInput);

      const versionString = String(newVersionInput) || nextVersion;

      const s = spinner();
      s.start("Updating files...");

      pkg.version = versionString;
      await writeFile(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");

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
    // Use inherited version if available, otherwise current
    if (inheritedVersion) {
      version = inheritedVersion;
    }
    note(`Staying on version ${version} (Amend Mode)`, "Info");
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 4: Channel Selection (New Release only, Amend inherits)
  // ═══════════════════════════════════════════════════════════════════
  let selectedChannel: string;

  if (isAmend && inheritedChannel) {
    selectedChannel = inheritedChannel;
    note(`Using inherited channel: ${selectedChannel}`, "Channel");
  } else {
    const channel = await select({
      message: "Select Release Channel:",
      options: [
        { value: "latest", label: "Latest (Stable)", hint: "Prod" },
        { value: "nightly", label: "Nightly (Dev)", hint: "Beta/Dev" },
        { value: "beta", label: "Beta", hint: "Testing" },
      ],
    });
    checkCancel(channel);
    selectedChannel = String(channel);
  }

  // Compute release version (e.g., 2.7.2-nightly)
  let releaseVersion = version;
  if (selectedChannel !== "latest" && !version.includes(`-${selectedChannel}`)) {
    releaseVersion = `${version}-${selectedChannel}`;
    note(`Pre-release detected. Will tag as: v${releaseVersion}`, "SemVer");
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 5: Commit
  // ═══════════════════════════════════════════════════════════════════

  if (isAmend) {
    // Amend flow: go directly to edit message question
    const editMsg = await confirm({
      message: "Edit commit message?",
      initialValue: false
    });
    checkCancel(editMsg);

    const s = spinner();

    if (!editMsg) {
      s.start("Amending commit...");
      await run("git", ["add", "."], s);
      await run("git", ["commit", "--amend", "--no-edit"], s);
      s.stop("Amended commit (no edit)");
      summary.push("Amended last commit (no message change)");
    } else {
      // Amend with new message via wizard
      const { commitMsg } = await runCommitWizard(releaseVersion, isAmend);
      s.start("Amending with new message...");
      await run("git", ["add", "."], s);
      await run("git", ["commit", "--amend", "-m", commitMsg], s);
      s.stop("Amended commit");
      summary.push(`Amended commit: "${commitMsg}"`);
    }
  } else {
    // New release flow: ask about creating commit
    const shouldCommit = await confirm({
      message: "Create local git commit?",
      initialValue: true,
    });
    checkCancel(shouldCommit);

    if (shouldCommit) {
      const { commitMsg } = await runCommitWizard(releaseVersion, isAmend);
      const s = spinner();
      s.start("Committing...");
      await run("git", ["add", "."], s);
      await run("git", ["commit", "-m", commitMsg], s);
      s.stop("Commit complete");
      summary.push(`Created commit: "${commitMsg}"`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 6: Tag Management (separate from commit)
  // ═══════════════════════════════════════════════════════════════════
  let tagged = false;

  if (isAmend && existingTags.length > 0) {
    // Amend: Offer to move existing tags to new commit
    const shouldMoveTag = await confirm({
      message: `Move tag ${existingTags[0]} to amended commit?`,
      initialValue: true
    });
    checkCancel(shouldMoveTag);

    if (shouldMoveTag) {
      const s = spinner();
      s.start(`Moving tag ${existingTags[0]}...`);
      // Force update the tag to point to new HEAD
      await run("git", ["tag", "-f", existingTags[0]], s);
      s.stop(`Tag ${existingTags[0]} moved to new commit`);
      tagged = true;
      summary.push(`Moved tag ${existingTags[0]} to new commit`);
    }
  } else {
    // New release or amend without existing tags: offer to create tag
    const shouldTag = await confirm({
      message: `Tag this commit as v${releaseVersion}?`,
      initialValue: true
    });
    checkCancel(shouldTag);

    if (shouldTag) {
      const s = spinner();
      s.start(`Tagging v${releaseVersion}...`);
      // Use -f in amend mode in case tag exists from previous attempt
      const tagArgs = isAmend
        ? ["tag", "-f", `v${releaseVersion}`]
        : ["tag", `v${releaseVersion}`];
      await run("git", tagArgs, s);
      s.stop(`Tagged v${releaseVersion}`);
      tagged = true;
      summary.push(`Tagged v${releaseVersion} locally`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 7: Build & Push Docker Image
  // ═══════════════════════════════════════════════════════════════════
  const shouldBuild = await confirm({
    message: `Build & Push to GHCR? (v${releaseVersion} + ${selectedChannel})`,
    initialValue: true,
  });
  checkCancel(shouldBuild);

  if (shouldBuild) {
    const s = spinner();
    s.start("Building multi-arch images (this may take a while)...");

    if (!IS_DRY_RUN) {
      try {
        const check = spawn({ cmd: ["docker", "buildx", "inspect", "mybuilder"], stdout: "ignore", stderr: "ignore" });
        if ((await check.exited) !== 0) throw new Error();
        await run("docker", ["buildx", "use", "mybuilder"]);
      } catch {
        await run("docker", ["buildx", "create", "--use", "--name", "mybuilder"]);
      }
    }

    const cleanSha = await getHeadSha();

    await run("docker", ["buildx", "build",
      "--platform", "linux/amd64,linux/arm64",
      "--provenance=false",
      "--push",
      "--build-arg", `COMMIT_SHA=${cleanSha}`,
      "--tag", `ghcr.io/dawescc/lettarrboxd:${releaseVersion}`,
      "--tag", `ghcr.io/dawescc/lettarrboxd:${selectedChannel}`,
      "."
    ], s);

    s.stop("Build & Push complete!");
    summary.push(`Built and pushed Docker images (tags: v${releaseVersion}, ${selectedChannel})`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 8: Git Push
  // ═══════════════════════════════════════════════════════════════════
  let pushMsg = isAmend ? "Force push commits to remote?" : "Push commits to remote?";
  if (tagged) {
    pushMsg = isAmend
      ? `Force push tag and commits?`
      : `Push git tag and commits?`;
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
      const tagFlags = isAmend ? ["push", "--tags", "--force"] : ["push", "--tags"];
      await run("git", tagFlags, s);
    }
    s.stop("Git sync complete");
    summary.push("Pushed commits to origin");
    if (tagged) summary.push(`Pushed tags to origin`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 9: GitHub Release (optional)
  // ═══════════════════════════════════════════════════════════════════
  if (tagged) {
    const shouldCreateRelease = await confirm({
      message: `Create GitHub Release for v${releaseVersion}?`,
      initialValue: false,
    });
    checkCancel(shouldCreateRelease);

    if (shouldCreateRelease) {
      // Step 1: Open editor for release notes (always, even in dry-run)
      const tmpNotesFile = path.join(process.cwd(), ".release-notes.tmp.md");
      const defaultNotes = `# Release v${releaseVersion}\n\n<!-- Write your release notes here. Save and close to continue. -->\n\n`;

      fs.writeFileSync(tmpNotesFile, defaultNotes);

      // Detect editor: prefer $EDITOR, fallback to code --wait, then vim
      const editor = process.env.EDITOR || process.env.VISUAL || "code";
      const editorArgs = editor.includes("code") ? ["--wait", tmpNotesFile] : [tmpNotesFile];

      note(`Opening ${editor} for release notes...`, "Editor");

      const editorProc = spawn({
        cmd: [editor, ...editorArgs],
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
      });
      await editorProc.exited;

      // Read the notes back and clean up
      let releaseNotes = fs.readFileSync(tmpNotesFile, "utf8");

      // Strip HTML comments (like the placeholder instructions)
      releaseNotes = releaseNotes.replace(/<!--[\s\S]*?-->/g, "").trim();

      // Clean up temp file
      fs.unlinkSync(tmpNotesFile);

      // Step 2: Create release with notes (skip in dry-run)
      const ghArgs = [
        "release", "create",
        `v${releaseVersion}`,
        "--title", `v${releaseVersion}`,
        "--notes", releaseNotes,
      ];

      // Mark as prerelease for non-stable channels
      if (selectedChannel !== "latest") {
        ghArgs.push("--prerelease");
      }

      if (IS_DRY_RUN) {
        note(`[DRY RUN] Would create release with notes:\n${releaseNotes.slice(0, 200)}...`, "GitHub Release");
      } else {
        const s = spinner();
        s.start("Creating GitHub release...");

        const p = spawn({
          cmd: ["gh", ...ghArgs],
          stdout: "inherit",
          stderr: "inherit",
        });
        const exitCode = await p.exited;

        if (exitCode !== 0) {
          s.stop("Release creation failed");
          note("GitHub release creation failed.", "Warning");
        } else {
          s.stop("GitHub release created!");
          summary.push(`Created GitHub release v${releaseVersion}`);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════
  if (IS_DRY_RUN) {
    note(summary.map(s => `[DRY RUN] ${s}`).join("\n"), "Dry Run Summary");
  } else {
    note(summary.join("\n"), "Release Summary");
  }

  outro(`Release v${releaseVersion} completed successfully! 🎉`);
}

// ═══════════════════════════════════════════════════════════════════
// Commit Message Wizard (extracted for reuse)
// ═══════════════════════════════════════════════════════════════════
async function runCommitWizard(releaseVersion: string, isAmend: boolean): Promise<{ commitMsg: string }> {
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

  const lines: string[] = [];
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

  return { commitMsg };
}

main().catch(console.error);
