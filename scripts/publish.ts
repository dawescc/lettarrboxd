import { spawn } from "bun";
import fs from "fs";
import path from "path";
import { intro, outro, text, select, multiselect, confirm, spinner, isCancel, cancel, note } from "@clack/prompts";

// ── Configuration ─────────────────────────────────────────────────────────────

const PKG_PATH = path.join(process.cwd(), "package.json");
const DOCKERFILE_PATH = path.join(process.cwd(), "Dockerfile");
const IS_DRY_RUN = process.argv.includes("--dry-run");

// ── State ─────────────────────────────────────────────────────────────────────

interface ReleaseState {
	pkg: any;
	version: string;
	releaseVersion: string;
	selectedChannel: string;
	isAmend: boolean;
	oldCommitSha: string;
	existingTags: string[];
	inheritedVersion: string;
	inheritedChannel: string;
	committed: boolean;
	tagged: boolean;
	summary: string[];
}

// Sentinel returned by a phase when the user wants to go back
const BACK = "back" as const;
type Back = typeof BACK;
type PhaseResult = Back | void;

// ── Helpers ───────────────────────────────────────────────────────────────────

function checkCancel(value: unknown) {
	if (isCancel(value)) {
		cancel("Operation cancelled.");
		process.exit(0);
	}
}

async function run(cmd: string, args: string[], s?: ReturnType<typeof spinner>) {
	const fullCmd = `${cmd} ${args.join(" ")}`;
	if (IS_DRY_RUN) {
		if (s) s.message(`[DRY RUN] Would execute: ${fullCmd}`);
		else console.log(`[DRY RUN] Would execute: ${fullCmd}`);
		return;
	}
	const p = spawn({ cmd: [cmd, ...args], stdout: "ignore", stderr: "inherit" });
	const exitCode = await p.exited;
	if (exitCode !== 0) throw new Error(`Command failed: ${fullCmd}`);
}

async function runWithOutput(cmd: string, args: string[]): Promise<string> {
	const p = spawn({ cmd: [cmd, ...args], stdout: "pipe", stderr: "ignore" });
	return (await new Response(p.stdout).text()).trim();
}

async function writeFile(filePath: string, content: string) {
	if (IS_DRY_RUN) {
		console.log(`[DRY RUN] Would write to ${path.basename(filePath)}`);
		return;
	}
	fs.writeFileSync(filePath, content);
}

async function getHeadSha(): Promise<string> {
	return runWithOutput("git", ["rev-parse", "HEAD"]);
}

async function getTagsOnCommit(sha: string): Promise<string[]> {
	if (!sha) return [];
	const output = await runWithOutput("git", ["tag", "--points-at", sha]);
	if (!output) return [];
	return output.split("\n").filter(Boolean);
}

function parseTag(tag: string): { version: string; channel: string } | null {
	const match = tag.match(/^v?([\d.]+)(?:-(.+))?$/);
	if (!match) return null;
	return { version: match[1], channel: match[2] || "latest" };
}

/** select() with a "← Back" option appended. Returns the chosen value or BACK. */
async function selectWithBack<T extends string>(
	message: string,
	options: { value: T; label: string; hint?: string }[]
): Promise<T | Back> {
	const result = await select({
		message,
		options: [...options, { value: BACK as any, label: "← Back" }],
	});
	checkCancel(result);
	return result as T | Back;
}

/** confirm() replacement that adds a "← Back" option. Returns true/false or BACK. */
async function confirmWithBack(message: string): Promise<boolean | Back> {
	const result = await select({
		message,
		options: [
			{ value: "yes",  label: "Yes" },
			{ value: "no",   label: "No" },
			{ value: BACK,   label: "← Back" },
		],
	});
	checkCancel(result);
	if (result === "yes") return true;
	if (result === "no") return false;
	return BACK;
}

// ── Commit Wizard ─────────────────────────────────────────────────────────────

async function runCommitWizard(releaseVersion: string): Promise<string> {
	const commitType = await select({
		message: "Commit Type:",
		options: [
			{ value: "chore",    label: "chore",    hint: "Build/Auxiliary" },
			{ value: "feat",     label: "feat",     hint: "New Feature" },
			{ value: "fix",      label: "fix",      hint: "Bug Fix" },
			{ value: "refactor", label: "refactor", hint: "Code Change" },
			{ value: "docs",     label: "docs",     hint: "Documentation" },
			{ value: "style",    label: "style",    hint: "Formatting" },
			{ value: "perf",     label: "perf",     hint: "Performance" },
			{ value: "test",     label: "test",     hint: "Tests" },
			{ value: "ci",       label: "ci",       hint: "CI Config" },
		],
	});
	checkCancel(commitType);

	const defaultTitle = `release v${releaseVersion}`;
	const commitTitleInput = await text({ message: "Commit Title:", placeholder: defaultTitle });
	checkCancel(commitTitleInput);
	const commitTitle = String(commitTitleInput) || defaultTitle;

	const lines: string[] = [];
	let addLine = await confirm({ message: "Add description items (bullet points)?", initialValue: false });
	checkCancel(addLine);

	while (Boolean(addLine)) {
		const lineInput = await text({ message: "Enter Item:", placeholder: "e.g. Added new feature" });
		checkCancel(lineInput);
		const lineStr = String(lineInput);
		if (lineStr) lines.push(`- ${lineStr}`);

		addLine = await confirm({ message: "Add another item?", initialValue: true });
		checkCancel(addLine);
	}

	const description = lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
	return `${String(commitType)}: ${commitTitle}${description}`;
}

// ── Phases ────────────────────────────────────────────────────────────────────

async function phaseInit(): Promise<ReleaseState> {
	const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
	note(`Current Version: ${pkg.version}`, "Info");
	return {
		pkg,
		version: pkg.version,
		releaseVersion: pkg.version,
		selectedChannel: "latest",
		isAmend: false,
		oldCommitSha: "",
		existingTags: [],
		inheritedVersion: "",
		inheritedChannel: "",
		committed: false,
		tagged: false,
		summary: [],
	};
}

// Phase 1 — no back option (nothing before it)
async function phaseReleaseMode(state: ReleaseState): Promise<PhaseResult> {
	const releaseMode = await select({
		message: "Release Mode:",
		options: [
			{ value: "new",   label: "New Release",     hint: "Bump version & create new tag" },
			{ value: "amend", label: "Roll-in (Amend)", hint: "Update last release (force push)" },
		],
	});
	checkCancel(releaseMode);
	state.isAmend = releaseMode === "amend";

	if (!state.isAmend) return;

	state.oldCommitSha = await getHeadSha();
	state.existingTags = await getTagsOnCommit(state.oldCommitSha);

	if (state.existingTags.length > 0) {
		const parsed = parseTag(state.existingTags[0]);
		if (parsed) {
			state.inheritedVersion = parsed.version;
			state.inheritedChannel = parsed.channel;
			note(
				`Found existing tag: ${state.existingTags[0]}\nWill inherit: version=${state.inheritedVersion}, channel=${state.inheritedChannel}`,
				"Amend Detection"
			);
		}
	} else {
		note("No existing tags found on last commit.", "Amend Detection");
	}
}

async function phaseVersionBump(state: ReleaseState): Promise<PhaseResult> {
	if (state.isAmend) {
		if (state.inheritedVersion) state.version = state.inheritedVersion;
		note(`Staying on version ${state.version} (Amend Mode)`, "Info");
		return;
	}

	const shouldBump = await confirmWithBack("Do you want to bump the version?");
	if (shouldBump === BACK) return BACK;
	if (!shouldBump) return;

	const parts = state.version.split(".");
	const lastIdx = parts.length - 1;
	const lastPart = parseInt(parts[lastIdx], 10);
	const nextVersion = !isNaN(lastPart)
		? [...parts.slice(0, lastIdx), lastPart + 1].join(".")
		: state.version;

	const newVersionInput = await text({ message: "Enter new version:", placeholder: nextVersion });
	checkCancel(newVersionInput);
	const versionString = String(newVersionInput) || nextVersion;

	const s = spinner();
	s.start("Updating files...");

	state.pkg.version = versionString;
	await writeFile(PKG_PATH, JSON.stringify(state.pkg, null, 2) + "\n");

	let dockerfile = fs.readFileSync(DOCKERFILE_PATH, "utf8");
	const versionRegex = /LABEL org.opencontainers.image.version="([^"]+)"/;
	if (dockerfile.match(versionRegex)) {
		dockerfile = dockerfile.replace(versionRegex, `LABEL org.opencontainers.image.version="${versionString}"`);
		await writeFile(DOCKERFILE_PATH, dockerfile);
	}

	s.stop(`Bumped to ${versionString}`);
	state.summary.push(`Bumped version from ${state.version} to ${versionString}`);
	state.version = versionString;
}

async function phaseChannel(state: ReleaseState): Promise<PhaseResult> {
	if (state.isAmend && state.inheritedChannel) {
		state.selectedChannel = state.inheritedChannel;
		note(`Using inherited channel: ${state.selectedChannel}`, "Channel");
	} else {
		const channel = await selectWithBack("Select Release Channel:", [
			{ value: "latest",  label: "Latest (Stable)", hint: "Prod" },
			{ value: "nightly", label: "Nightly (Dev)",   hint: "Beta/Dev" },
			{ value: "beta",    label: "Beta",            hint: "Testing" },
		]);
		if (channel === BACK) return BACK;
		state.selectedChannel = channel;
	}

	state.releaseVersion = state.version;
	if (state.selectedChannel !== "latest" && !state.version.includes(`-${state.selectedChannel}`)) {
		state.releaseVersion = `${state.version}-${state.selectedChannel}`;
		note(`Pre-release detected. Will tag as: v${state.releaseVersion}`, "SemVer");
	}
}

async function phaseCommit(state: ReleaseState): Promise<PhaseResult> {
	const s = spinner();

	if (state.isAmend) {
		const editMsg = await confirmWithBack("Edit commit message?");
		if (editMsg === BACK) return BACK;

		if (!editMsg) {
			s.start("Amending commit...");
			await run("git", ["add", "."], s);
			await run("git", ["commit", "--amend", "--no-edit"], s);
			s.stop("Amended commit (no edit)");
			state.summary.push("Amended last commit (no message change)");
		} else {
			const commitMsg = await runCommitWizard(state.releaseVersion);
			s.start("Amending with new message...");
			await run("git", ["add", "."], s);
			await run("git", ["commit", "--amend", "-m", commitMsg], s);
			s.stop("Amended commit");
			state.summary.push(`Amended commit: "${commitMsg}"`);
		}
		state.committed = true;
		return;
	}

	const shouldCommit = await confirmWithBack("Create local git commit?");
	if (shouldCommit === BACK) return BACK;

	if (!shouldCommit) {
		state.summary.push("Skipped local git commit");
		return;
	}

	const commitMsg = await runCommitWizard(state.releaseVersion);
	s.start("Committing...");
	await run("git", ["add", "."], s);
	await run("git", ["commit", "-m", commitMsg], s);
	s.stop("Commit complete");
	state.committed = true;
	state.summary.push(`Created commit: "${commitMsg}"`);
}

async function phaseTags(state: ReleaseState): Promise<PhaseResult> {
	if (!state.isAmend && !state.committed) {
		state.summary.push("Skipped git tagging because no commit was created");
		return;
	}

	if (state.isAmend && state.existingTags.length > 0) {
		const shouldMoveTag = await confirmWithBack(`Move tag ${state.existingTags[0]} to amended commit?`);
		if (shouldMoveTag === BACK) return BACK;

		if (shouldMoveTag) {
			const s = spinner();
			s.start(`Moving tag ${state.existingTags[0]}...`);
			await run("git", ["tag", "-f", state.existingTags[0]], s);
			s.stop(`Tag ${state.existingTags[0]} moved to new commit`);
			state.tagged = true;
			state.summary.push(`Moved tag ${state.existingTags[0]} to new commit`);
		}
		return;
	}

	const shouldTag = await confirmWithBack(`Tag this commit as v${state.releaseVersion}?`);
	if (shouldTag === BACK) return BACK;

	if (shouldTag) {
		const s = spinner();
		s.start(`Tagging v${state.releaseVersion}...`);
		const tagArgs = state.isAmend
			? ["tag", "-f", `v${state.releaseVersion}`]
			: ["tag", `v${state.releaseVersion}`];
		await run("git", tagArgs, s);
		s.stop(`Tagged v${state.releaseVersion}`);
		state.tagged = true;
		state.summary.push(`Tagged v${state.releaseVersion} locally`);
	}
}

async function phaseBuildPush(state: ReleaseState): Promise<PhaseResult> {
	const shouldBuild = await confirmWithBack(`Build and push container? (v${state.releaseVersion} + ${state.selectedChannel})`);
	if (shouldBuild === BACK) return BACK;
	if (!shouldBuild) return;

	const registryChoice = await multiselect({
		message: "Push where? (select all that apply)",
		options: [
			{ value: "all",     label: "All",     hint: "Forgejo + GHCR" },
			{ value: "forgejo", label: "Forgejo", hint: "forgejo.dawes.cc/ryan/lettarrboxd" },
			{ value: "ghcr",    label: "GHCR",    hint: "ghcr.io/dawescc/lettarrboxd" },
		],
		initialValues: ["all"],
	});
	checkCancel(registryChoice);

	const picked = registryChoice as string[];
	const selected = picked.includes("all") ? ["forgejo", "ghcr"] : picked;

	const tags: string[] = [];
	if (selected.includes("forgejo")) {
		tags.push("--tag", `forgejo.dawes.cc/ryan/lettarrboxd:${state.releaseVersion}`);
		tags.push("--tag", `forgejo.dawes.cc/ryan/lettarrboxd:${state.selectedChannel}`);
	}
	if (selected.includes("ghcr")) {
		tags.push("--tag", `ghcr.io/dawescc/lettarrboxd:${state.releaseVersion}`);
		tags.push("--tag", `ghcr.io/dawescc/lettarrboxd:${state.selectedChannel}`);
	}

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
	await run("docker", [
		"buildx", "build",
		"--platform", "linux/amd64,linux/arm64",
		"--provenance=false",
		"--push",
		"--build-arg", `COMMIT_SHA=${cleanSha}`,
		...tags,
		".",
	], s);

	s.stop("Build & Push complete!");
	state.summary.push(`Built and pushed to: ${selected.join(", ")} (tags: ${state.releaseVersion}, ${state.selectedChannel})`);
}

async function phaseGitPush(state: ReleaseState): Promise<PhaseResult> {
	if (!state.isAmend && !state.committed) {
		state.summary.push("Skipped git push because no commit was created");
		return;
	}

	let pushMsg = state.isAmend ? "Force push commits to remote?" : "Push commits to remote?";
	if (state.tagged) {
		pushMsg = state.isAmend ? "Force push tag and commits?" : "Push git tag and commits?";
	}

	const shouldPushGit = await confirmWithBack(pushMsg);
	if (shouldPushGit === BACK) return BACK;
	if (!shouldPushGit) return;

	const s = spinner();
	s.start("Pushing to origin...");

	await run("git", state.isAmend ? ["push", "--force"] : ["push"], s);
	if (state.tagged) {
		await run("git", state.isAmend ? ["push", "--tags", "--force"] : ["push", "--tags"], s);
	}

	s.stop("Git sync complete");
	state.summary.push("Pushed commits to origin");
	if (state.tagged) state.summary.push("Pushed tags to origin");
}

async function phaseRelease(state: ReleaseState): Promise<PhaseResult> {
	if (!state.tagged) return;

	const shouldCreateRelease = await confirmWithBack(`Create GitHub Release for v${state.releaseVersion}?`);
	if (shouldCreateRelease === BACK) return BACK;
	if (!shouldCreateRelease) return;

	const tmpNotesFile = path.join(process.cwd(), ".release-notes.tmp.md");
	const defaultNotes = `# Release v${state.releaseVersion}\n\n<!-- Write your release notes here. Save and close to continue. -->\n\n`;
	fs.writeFileSync(tmpNotesFile, defaultNotes);

	const editor = process.env.EDITOR || process.env.VISUAL || "code";
	const editorArgs = editor.includes("code") ? ["--wait", tmpNotesFile] : [tmpNotesFile];
	note(`Opening ${editor} for release notes...`, "Editor");

	const editorProc = spawn({ cmd: [editor, ...editorArgs], stdout: "inherit", stderr: "inherit", stdin: "inherit" });
	await editorProc.exited;

	let releaseNotes = fs.readFileSync(tmpNotesFile, "utf8");
	releaseNotes = releaseNotes.replace(/<!--[\s\S]*?-->/g, "").trim();
	fs.unlinkSync(tmpNotesFile);

	const ghArgs = [
		"release", "create", `v${state.releaseVersion}`,
		"--title", `v${state.releaseVersion}`,
		"--notes", releaseNotes,
	];
	if (state.selectedChannel !== "latest") ghArgs.push("--prerelease");

	if (IS_DRY_RUN) {
		note(`[DRY RUN] Would create release with notes:\n${releaseNotes.slice(0, 200)}...`, "GitHub Release");
		return;
	}

	const s = spinner();
	s.start("Creating GitHub release...");

	const p = spawn({ cmd: ["gh", ...ghArgs], stdout: "inherit", stderr: "inherit" });
	const exitCode = await p.exited;

	if (exitCode !== 0) {
		s.stop("Release creation failed");
		note("GitHub release creation failed.", "Warning");
	} else {
		s.stop("GitHub release created!");
		state.summary.push(`Created GitHub release v${state.releaseVersion}`);
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
	console.clear();
	intro(`🚀 Lettarrboxd Release CLI ${IS_DRY_RUN ? "(DRY RUN)" : ""}`);

	const state = await phaseInit();

	const phases: Array<(state: ReleaseState) => Promise<PhaseResult>> = [
		phaseReleaseMode,
		phaseVersionBump,
		phaseChannel,
		phaseCommit,
		phaseTags,
		phaseBuildPush,
		phaseGitPush,
		phaseRelease,
	];

	let i = 0;
	while (i < phases.length) {
		const result = await phases[i](state);
		if (result === BACK) {
			i = Math.max(0, i - 1);
		} else {
			i++;
		}
	}

	if (IS_DRY_RUN) {
		note(state.summary.map((s) => `[DRY RUN] ${s}`).join("\n"), "Dry Run Summary");
	} else {
		note(state.summary.join("\n"), "Release Summary");
	}

	outro(`Release v${state.releaseVersion} completed successfully! 🎉`);
}

main().catch(console.error);
