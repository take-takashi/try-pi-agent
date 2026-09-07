import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { StringEnum, Type, uuidv7 } from "@earendil-works/pi-ai";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const BRANCH_KINDS = [
	"feat",
	"fix",
	"refactor",
	"chore",
	"docs",
	"test",
	"perf",
	"ci",
	"build",
	"revert",
] as const;

const BRANCH_PATTERN = /^(feat|fix|refactor|chore|docs|test|perf|ci|build|revert)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BRANCH_NAMER_PROMPT = `You name Git branches for a coding task.
Return exactly one branch name and nothing else.
Use this format: <kind>/<scope>-<short-kebab-summary>
Allowed kinds: feat, fix, refactor, chore, docs, test, perf, ci, build, revert.
Use lowercase ASCII letters, numbers, and hyphens only after the slash.
Keep it concise and descriptive.
Example: feat/auth-add-passkey-login`;

type PendingSwitch = {
	sessionFile: string;
	branch: string;
	target: string;
};

const pendingSwitches = new Map<string, PendingSwitch>();

function slugify(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");
}

function makeBranchName(kind: string, scope: string | undefined, summary: string): string {
	if (!BRANCH_KINDS.includes(kind as (typeof BRANCH_KINDS)[number])) {
		throw new Error(`対応していないbranch種別です: ${kind}`);
	}

	const parts = [scope, summary].map((part) => slugify(part ?? "")).filter(Boolean);
	if (parts.length === 0) {
		throw new Error("branch名を作るにはscopeまたはsummaryが必要です");
	}

	const branch = `${kind}/${parts.join("-")}`;
	validateBranchName(branch);
	return branch;
}

function validateBranchName(branch: string): void {
	if (!BRANCH_PATTERN.test(branch)) {
		throw new Error(
			`branch名が規約に合いません: ${branch}。例: feat/auth-add-passkey-login`,
		);
	}
}

async function git(
	pi: ExtensionAPI,
	cwd: string,
	args: string[],
	signal?: AbortSignal,
): Promise<string> {
	const result = await pi.exec("git", args, {
		cwd,
		signal,
		timeout: 30_000,
	});
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		throw new Error(`git ${args.join(" ")} failed: ${detail}`);
	}
	return result.stdout.trim();
}

async function getTargetPath(pi: ExtensionAPI, cwd: string, branch: string, signal?: AbortSignal): Promise<string> {
	const repoRoot = await git(pi, cwd, ["rev-parse", "--show-toplevel"], signal);
	const directoryName = `${basename(repoRoot)}-${branch.replaceAll("/", "-")}`;
	return resolve(dirname(repoRoot), directoryName);
}

async function provisionWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	branch: string,
	signal?: AbortSignal,
): Promise<PendingSwitch> {
	validateBranchName(branch);

	const sourceSessionFile = ctx.sessionManager.getSessionFile();
	if (!sourceSessionFile) {
		throw new Error("会話履歴を引き継ぐには、保存されるPiセッションが必要です（--no-sessionは使わないでください）");
	}

	const target = await getTargetPath(pi, ctx.cwd, branch, signal);
	const repoRoot = await git(pi, ctx.cwd, ["rev-parse", "--show-toplevel"], signal);
	const result = await pi.exec("git", ["worktree", "add", "-b", branch, target], {
		cwd: repoRoot,
		signal,
		timeout: 30_000,
	});
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		throw new Error(`worktreeを作成できませんでした: ${detail}`);
	}

	try {
		const targetSession = SessionManager.forkFrom(sourceSessionFile, target);
		const sessionFile = targetSession.getSessionFile();
		if (!sessionFile) throw new Error("移動先のPiセッションを作成できませんでした");
		return { sessionFile, branch, target };
	} catch (error) {
		throw new Error(
			`worktreeは${target}に作成されましたが、Piセッションを準備できませんでした: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

async function confirmWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	branch: string,
	target: string,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!ctx.hasUI) return true;

	let warning = "";
	try {
		const status = await git(pi, ctx.cwd, ["status", "--porcelain"], signal);
		if (status) {
			warning = "\n警告: 未コミットの変更は現在のworktreeに残ります。";
		}
	} catch {
		warning = "\n警告: 現在のGit状態を確認できませんでした。";
	}

	return ctx.ui.confirm(
		"worktreeを作成して切り替えますか？",
		`branch: ${branch}\n場所: ${target}${warning}`,
	);
}

function extractBranchName(output: string): string | undefined {
	return output
		.replace(/```(?:text|txt|bash)?/gi, "")
		.replaceAll("```", "")
		.split(/\s+/)
		.map((candidate) => candidate.trim().replace(/^['"]|['"]$/g, ""))
		.find((candidate) => BRANCH_PATTERN.test(candidate));
}

async function generateBranchName(ctx: ExtensionCommandContext, goal: string): Promise<string> {
	if (!ctx.model) throw new Error("モデルが選択されていません");

	const response = await ctx.modelRegistry.complete(
		ctx.model,
		{
			systemPrompt: BRANCH_NAMER_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: goal }],
					timestamp: Date.now(),
				},
			],
		},
		{
			signal: AbortSignal.timeout(30_000),
			cacheRetention: "none",
			sessionId: uuidv7(),
		},
	);

	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	const branch = extractBranchName(text);
	if (!branch) {
		throw new Error(`LLMが規約に合わないbranch名を返しました: ${text || "（空）"}`);
	}
	return branch;
}

async function switchTo(ctx: ExtensionCommandContext, pending: PendingSwitch): Promise<void> {
	const result = await ctx.switchSession(pending.sessionFile, {
		withSession: async (replacementCtx) => {
			replacementCtx.ui.notify(`${pending.branch}へ切り替えました`, "info");
		},
	});

	if (result.cancelled) {
		ctx.ui.notify(`worktreeは作成しましたが、セッション切り替えをキャンセルしました: ${pending.target}`, "warning");
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		try {
			await git(pi, ctx.cwd, ["rev-parse", "--show-toplevel"]);
			const branch = (await git(pi, ctx.cwd, ["branch", "--show-current"])) || "detached";
			ctx.ui.setStatus("worktree-session", `wt: ${basename(ctx.cwd)} · ${branch}`);
		} catch {
			ctx.ui.setStatus("worktree-session", "wt: Gitなし");
		}
	});

	// 手動入口: /worktree <目的>
	// 現在のモデルがbranch名を決め、その後worktreeを作成して切り替える。
	pi.registerCommand("worktree", {
		description: "LLMにConventional Branch名を決めてもらい、worktreeを作成して切り替える",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("使い方: /worktree <目的>", "error");
				return;
			}

			try {
				const branch = await generateBranchName(ctx, goal);
				const target = await getTargetPath(pi, ctx.cwd, branch);
				if (!(await confirmWorktree(pi, ctx, branch, target))) {
					ctx.ui.notify("キャンセルしました", "info");
					return;
				}
				const pending = await provisionWorktree(pi, ctx, branch);
				await switchTo(ctx, pending);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	// セッション切り替えはcommand contextからしか呼べないため、この内部commandを経由する。
	pi.registerCommand("worktree-switch", {
		description: "worktreeセッションを切り替える内部command",
		handler: async (args, ctx) => {
			const token = args.trim();
			const pending = pendingSwitches.get(token);
			if (!pending) {
				ctx.ui.notify("worktreeの切り替え要求が見つからないか、有効期限切れです", "error");
				return;
			}
			pendingSwitches.delete(token);
			await ctx.waitForIdle();
			await switchTo(ctx, pending);
		},
	});

	pi.registerTool({
		name: "create_worktree",
		label: "Worktreeを作成",
		description:
			"Create a new Git worktree and continue the current Pi conversation there. Choose a conventional branch kind, optional scope, and concise English summary.",
		promptSnippet: "Create and switch to a Git worktree with a conventional branch name",
		promptGuidelines: [
			"Use create_worktree when the user asks to isolate the current task in a new worktree.",
			"Choose the branch kind from feat, fix, refactor, chore, docs, test, perf, ci, build, or revert.",
			"Use a concise lowercase English summary; the extension validates and formats the final branch name.",
		],
		parameters: Type.Object({
			kind: StringEnum(BRANCH_KINDS),
			scope: Type.Optional(Type.String({ description: "Short area name, such as auth or api" })),
			summary: Type.String({ description: "Short English kebab-case task summary" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const branch = makeBranchName(params.kind, params.scope, params.summary);
			const target = await getTargetPath(pi, ctx.cwd, branch, signal);
			if (!(await confirmWorktree(pi, ctx, branch, target, signal))) {
				return {
					content: [{ type: "text", text: "worktreeの作成をキャンセルしました。" }],
					details: {},
				};
			}

			const pending = await provisionWorktree(pi, ctx, branch, signal);
			const token = randomUUID();
			pendingSwitches.set(token, pending);
			pi.sendUserMessage(`/worktree-switch ${token}`, {
				deliverAs: "followUp",
				expandPromptTemplates: true,
			});

			return {
				content: [{ type: "text", text: `${branch}を作成しました。${target}へのセッション切り替えを予約しました。` }],
				details: pending,
				terminate: true,
			};
		},
	});
}
