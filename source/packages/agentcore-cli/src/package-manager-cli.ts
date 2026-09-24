import chalk from "chalk";
import { selectConfig } from "./cli/config-selector.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import { APP_NAME, CONFIG_DIR_NAME, getAgentDir } from "./config.ts";
import type { InlineExtension } from "./core/extensions/types.ts";
import { DefaultPackageManager } from "./core/package-manager.ts";
import { type AppMode, resolveProjectTrusted } from "./core/project-trust.ts";
import { DefaultResourceLoader } from "./core/resource-loader.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";

export interface PackageCommandRuntimeOptions {
	extensionFactories?: InlineExtension[];
}

type PackageCommand = "install" | "remove" | "update" | "list";

function usage(command: PackageCommand): string {
	switch (command) {
		case "install": return `${APP_NAME} install <source> [-l] [--approve|--no-approve]`;
		case "remove": return `${APP_NAME} remove <source> [-l] [--approve|--no-approve]`;
		case "update": return `${APP_NAME} update [--extensions|--extension <source>] [--approve|--no-approve]`;
		case "list": return `${APP_NAME} list [--approve|--no-approve]`;
	}
}

async function createCommandSettingsManager(options: {
	cwd: string;
	agentDir: string;
	projectTrustOverride?: boolean;
	useSavedProjectTrustOnly?: boolean;
	extensionFactories?: InlineExtension[];
}): Promise<SettingsManager> {
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false });
	const trustStore = new ProjectTrustStore(options.agentDir);
	if (options.useSavedProjectTrustOnly) {
		settingsManager.setProjectTrusted(options.projectTrustOverride ?? trustStore.get(options.cwd) === true);
		return settingsManager;
	}
	const mode: AppMode = process.stdin.isTTY && process.stdout.isTTY ? "interactive" : "print";
	const extensionsResult = options.projectTrustOverride === undefined && hasTrustRequiringProjectResources(options.cwd)
		? await new DefaultResourceLoader({
				cwd: options.cwd, agentDir: options.agentDir, settingsManager,
				extensionFactories: options.extensionFactories,
			}).loadProjectTrustExtensions()
		: undefined;
	for (const error of extensionsResult?.errors ?? []) {
		console.error(chalk.yellow(`警告：扩展 ${error.path} 加载失败：${error.error}`));
	}
	const trusted = await resolveProjectTrusted({
		cwd: options.cwd,
		trustStore,
		trustOverride: options.projectTrustOverride,
		defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
		extensionsResult,
		projectTrustContext: createProjectTrustContext({
			cwd: options.cwd, mode, settingsManager, hasUI: mode === "interactive",
		}),
		onExtensionError: (message) => console.error(chalk.yellow(`警告：${message}`)),
	});
	settingsManager.setProjectTrusted(trusted);
	return settingsManager;
}

export async function handleConfigCommand(args: string[], runtimeOptions: PackageCommandRuntimeOptions = {}): Promise<boolean> {
	if (args[0] !== "config") return false;
	const rest = args.slice(1);
	const commandUsage = `${APP_NAME} config [-l] [--approve|--no-approve]`;
	if (rest.includes("-h") || rest.includes("--help")) {
		console.log(`用法：${commandUsage}\n打开资源配置 TUI，以启用或禁用包资源。`);
		return true;
	}
	const local = rest.includes("-l") || rest.includes("--local");
	const invalid = rest.find((arg) => !["-l", "--local", "-a", "--approve", "-na", "--no-approve"].includes(arg));
	if (invalid || (rest.includes("--approve") || rest.includes("-a")) && (rest.includes("--no-approve") || rest.includes("-na"))) {
		console.error(chalk.red(`config 参数无效：${invalid ?? "冲突的信任选项"}。用法：${commandUsage}`));
		process.exitCode = 1;
		return true;
	}
	const override = rest.includes("--approve") || rest.includes("-a") ? true
		: rest.includes("--no-approve") || rest.includes("-na") ? false : undefined;
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = await createCommandSettingsManager({
		cwd, agentDir, projectTrustOverride: override, extensionFactories: runtimeOptions.extensionFactories,
	});
	if (local && !settingsManager.isProjectTrusted()) {
		console.error(chalk.red("项目未受信任。请使用 --approve 修改项目本地资源配置。"));
		process.exitCode = 1;
		return true;
	}
	const globalSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const global = await new DefaultPackageManager({ cwd, agentDir, settingsManager: globalSettings }).resolve();
	const project = settingsManager.isProjectTrusted()
		? await new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve() : global;
	await selectConfig({
		resolvedPaths: { global, project }, settingsManager, cwd, agentDir,
		writeScope: local ? "project" : "global", projectModeAvailable: settingsManager.isProjectTrusted(),
	});
	process.exit(0);
}

export async function handlePackageCommand(args: string[], runtimeOptions: PackageCommandRuntimeOptions = {}): Promise<boolean> {
	const raw = args[0];
	const command: PackageCommand | undefined = raw === "uninstall" ? "remove"
		: raw === "install" || raw === "remove" || raw === "update" || raw === "list" ? raw : undefined;
	if (!command) return false;
	const rest = args.slice(1);
	if (rest.includes("-h") || rest.includes("--help")) {
		console.log(`用法：${usage(command)}`);
		return true;
	}

	// This local-only release has no updater or remote model catalog. Reject before loading settings or packages.
	if (command === "update" && rest.some((arg) => ["self", "pi", "--self", "--all", "--models", "--force"].includes(arg))) {
		console.error(chalk.red("agentCore 不支持自更新或远程模型目录刷新；仅可更新显式配置的扩展。"));
		process.exitCode = 1;
		return true;
	}
	const local = rest.includes("-l") || rest.includes("--local");
	const approve = rest.includes("-a") || rest.includes("--approve");
	const disapprove = rest.includes("-na") || rest.includes("--no-approve");
	const extensionIndex = rest.indexOf("--extension");
	const updateSource = extensionIndex < 0 ? undefined : rest[extensionIndex + 1];
	const positional = rest.filter((arg, index) => !arg.startsWith("-") && (extensionIndex < 0 || index !== extensionIndex + 1));
	const flags = rest.filter((arg) => arg.startsWith("-"));
	const validFlags = command === "update" ? ["--extensions", "--extension", "-a", "--approve", "-na", "--no-approve"]
		: command === "list" ? ["-a", "--approve", "-na", "--no-approve"]
		: ["-l", "--local", "-a", "--approve", "-na", "--no-approve"];
	const invalid = flags.find((flag) => !validFlags.includes(flag));
	if (invalid || approve && disapprove || positional.length > (command === "list" ? 0 : 1)
		|| command === "update" && (extensionIndex >= 0 && (!updateSource || updateSource.startsWith("-") || positional.length > 0))
		|| command === "update" && rest.includes("--extensions") && (updateSource || positional.length > 0)) {
		console.error(chalk.red(`命令 "${command}" 参数无效${invalid ? `：${invalid}` : ""}。用法：${usage(command)}`));
		process.exitCode = 1;
		return true;
	}
	const source = command === "update" ? updateSource ?? positional[0] : positional[0];
	if ((command === "install" || command === "remove") && !source) {
		console.error(chalk.red(`${command} 缺少 source。用法：${usage(command)}`));
		process.exitCode = 1;
		return true;
	}
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = await createCommandSettingsManager({
		cwd, agentDir, projectTrustOverride: approve ? true : disapprove ? false : undefined,
		useSavedProjectTrustOnly: command === "update", extensionFactories: runtimeOptions.extensionFactories,
	});
	if (local && !settingsManager.isProjectTrusted()) {
		console.error(chalk.red("项目未受信任。请使用 --approve 修改项目本地包配置。"));
		process.exitCode = 1;
		return true;
	}
	const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	try {
		switch (command) {
			case "install":
				await manager.installAndPersist(source!, { local });
				console.log(chalk.green(`已安装 ${source}`));
				break;
			case "remove":
				if (!await manager.removeAndPersist(source!, { local })) {
					console.error(chalk.red(`未找到与 ${source} 匹配的包`));
					process.exitCode = 1;
				} else console.log(chalk.green(`已移除 ${source}`));
				break;
			case "update":
				await manager.update(source);
				console.log(chalk.green(source ? `已更新 ${source}` : "已更新扩展"));
				break;
			case "list": {
				const packages = manager.listConfiguredPackages();
				if (!packages.length) console.log(chalk.dim("未安装任何包。"));
				for (const scope of ["user", "project"] as const) {
					const entries = packages.filter((pkg) => pkg.scope === scope);
					if (entries.length) console.log(chalk.bold(scope === "user" ? "用户包：" : "项目包："));
					for (const pkg of entries) console.log(`  ${pkg.source}`);
				}
				break;
			}
		}
	} catch (error) {
		console.error(chalk.red(`包命令失败：${error instanceof Error ? error.message : String(error)}`));
		process.exitCode = 1;
	}
	return true;
}
