import { type SpawnOptions, spawn } from "child_process";

export interface SSHResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Execute an SSH command and return the result
 */
export const sshExec = async (
	sshCmd: string,
	command: string,
	options?: { keepAlive?: boolean },
): Promise<SSHResult> => {
	return new Promise((resolve) => {
		// Parse SSH command (e.g., "ssh root@1.2.3.4" or "ssh -p 22 root@1.2.3.4")
		const sshParts = sshCmd.split(" ").filter((p) => p);
		const sshBinary = sshParts[0];
		let sshArgs = [...sshParts.slice(1)];

		// Add SSH keepalive options for long-running commands
		if (options?.keepAlive) {
			// ServerAliveInterval=30 sends keepalive every 30 seconds
			// ServerAliveCountMax=120 allows up to 120 failures (60 minutes total)
			sshArgs = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=120", ...sshArgs];
		}

		sshArgs.push(command);

		const proc = spawn(sshBinary, sshArgs, {
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			resolve({
				stdout,
				stderr,
				exitCode: code || 0,
			});
		});

		proc.on("error", (err) => {
			resolve({
				stdout,
				stderr: err.message,
				exitCode: 1,
			});
		});
	});
};

/**
 * Execute an SSH command with streaming output to console
 */
export const sshExecStream = async (
	sshCmd: string,
	command: string,
	options?: { silent?: boolean; forceTTY?: boolean; keepAlive?: boolean },
): Promise<number> => {
	return new Promise((resolve) => {
		const sshParts = sshCmd.split(" ").filter((p) => p);
		const sshBinary = sshParts[0];

		// Build SSH args
		let sshArgs = [...sshParts.slice(1)];

		// Add -t flag if requested and not already present
		if (options?.forceTTY && !sshParts.includes("-t")) {
			sshArgs = ["-t", ...sshArgs];
		}

		// Add SSH keepalive options for long-running commands
		if (options?.keepAlive) {
			// ServerAliveInterval=30 sends keepalive every 30 seconds
			// ServerAliveCountMax=120 allows up to 120 failures (60 minutes total)
			sshArgs = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=120", ...sshArgs];
		}

		sshArgs.push(command);

		const spawnOptions: SpawnOptions = options?.silent
			? { stdio: ["ignore", "ignore", "ignore"] }
			: { stdio: "inherit" };

		const proc = spawn(sshBinary, sshArgs, spawnOptions);

		proc.on("close", (code) => {
			resolve(code || 0);
		});

		proc.on("error", () => {
			resolve(1);
		});
	});
};

// OpenSSH client options that consume an argument (`man ssh`). Needed to tell
// `-i key root@h` apart from a destination: treating every non-dash token as the
// host made `ssh -i key root@h` resolve to "key".
const SSH_OPTIONS_WITH_ARG = new Set("BbcDEeFIiJLlmOopQRSWw");

export interface SshOption {
	flag: string;
	value?: string;
}

export interface ParsedSshCommand {
	binary: string;
	options: SshOption[];
	/** Destination as written, e.g. `root@1.2.3.4` or `my-host`. Empty if missing. */
	destination: string;
}

/**
 * Parse a pod's stored SSH command (e.g. "ssh -p 2222 -i ~/.ssh/key root@1.2.3.4").
 */
export const parseSshCommand = (sshCmd: string): ParsedSshCommand => {
	const parts = sshCmd.split(" ").filter((p) => p);
	const options: SshOption[] = [];
	let destination = "";

	for (let i = 1; i < parts.length; i++) {
		const part = parts[i];
		if (part.startsWith("-") && part.length > 1) {
			const flag = part[1];
			if (SSH_OPTIONS_WITH_ARG.has(flag)) {
				// Both "-p 22" and "-p22" are accepted by ssh.
				if (part.length > 2) {
					options.push({ flag, value: part.slice(2) });
				} else {
					options.push({ flag, value: parts[i + 1] });
					i++;
				}
			} else {
				// Grouped boolean flags such as "-tA".
				for (const f of part.slice(1)) options.push({ flag: f });
			}
			continue;
		}
		destination = part;
		break;
	}

	return { binary: parts[0] ?? "ssh", options, destination };
};

/**
 * Host name or address of the pod (user and port stripped), or undefined when
 * the SSH command has no destination.
 */
export const getSshHost = (sshCmd: string): string | undefined => {
	const { destination } = parseSshCommand(sshCmd);
	if (!destination) return undefined;
	let host = destination.replace(/^ssh:\/\//, "");
	host = host.slice(host.lastIndexOf("@") + 1);
	// ssh://host:port form only; a bare destination cannot carry a port.
	if (destination.startsWith("ssh://")) host = host.replace(/:\d+$/, "");
	return host || undefined;
};

// scp equivalents of ssh options. The port flag differs (-p -> -P) and -l (login
// name in ssh) means a bandwidth limit in scp, so it is folded into the
// destination instead. Options with no scp meaning (-t, -L, -A ...) are dropped.
const SCP_PASSTHROUGH_WITH_ARG = new Set(["i", "o", "F", "J", "c"]);
const SCP_PASSTHROUGH_BOOLEAN = new Set(["4", "6", "C", "q"]);

/**
 * Build scp arguments that reuse the connection options of a pod's SSH command.
 */
export const buildScpArgs = (sshCmd: string, localPath: string, remotePath: string): string[] | undefined => {
	const { options, destination } = parseSshCommand(sshCmd);
	if (!destination) return undefined;

	const args: string[] = [];
	let login: string | undefined;
	for (const { flag, value } of options) {
		if (flag === "p" && value) {
			args.push("-P", value);
		} else if (flag === "l" && value) {
			login = value;
		} else if (SCP_PASSTHROUGH_WITH_ARG.has(flag) && value) {
			args.push(`-${flag}`, value);
		} else if (SCP_PASSTHROUGH_BOOLEAN.has(flag) && value === undefined) {
			args.push(`-${flag}`);
		}
	}

	const target = login && !destination.includes("@") ? `${login}@${destination}` : destination;
	args.push(localPath, `${target}:${remotePath}`);
	return args;
};

/**
 * Copy a file to remote via SCP
 */
export const scpFile = async (sshCmd: string, localPath: string, remotePath: string): Promise<boolean> => {
	const scpArgs = buildScpArgs(sshCmd, localPath, remotePath);
	if (!scpArgs) {
		console.error("Could not parse host from SSH command");
		return false;
	}

	return new Promise((resolve) => {
		const proc = spawn("scp", scpArgs, { stdio: "inherit" });

		proc.on("close", (code) => {
			resolve(code === 0);
		});

		proc.on("error", () => {
			resolve(false);
		});
	});
};
