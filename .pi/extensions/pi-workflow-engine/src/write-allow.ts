import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { InlineExtension, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isPathWithin } from "./tree-fingerprint.ts";

export interface WriteAllowPolicy {
  readonly workspaceRoot: string;
  readonly patterns: readonly string[];
  readonly matchers: readonly RegExp[];
}

export interface WriteAllowViolation {
  readonly path: string;
  readonly reason: string;
}

const WRAPPERS = new Set(["sudo", "env", "timeout", "nice", "nohup", "stdbuf"]);
const WRITE_COMMANDS = new Set(["tee", "mv", "cp", "rm", "install", "sed", "dd", "git"]);
const SHELL_SEPARATORS = new Set(["&&", "||", ";", "|"]);

export function compileWriteAllow(workspaceRoot: string, patterns: readonly string[]): WriteAllowPolicy {
  if (!Array.isArray(patterns)) throw new Error("writeAllow must be an array of workspace-relative glob patterns");
  const normalized = patterns.map(normalizePattern);
  return {
    workspaceRoot: resolve(workspaceRoot),
    patterns: normalized,
    matchers: normalized.map(globToRegExp),
  };
}

export function createWriteAllowExtension(input: {
  readonly workspaceRoot: string;
  readonly patterns: readonly string[];
  readonly label: string;
  readonly log: (message: string) => void;
}): InlineExtension {
  const policy = compileWriteAllow(input.workspaceRoot, input.patterns);
  return {
    name: "workflow-write-allow",
    hidden: true,
    factory(pi) {
      pi.on("tool_call", async (event) => {
        const violation = await toolWriteViolation(event, policy);
        if (!violation) return undefined;
        const allowlist = policy.patterns.length > 0 ? policy.patterns.join(", ") : "(read-only: empty)";
        const reason = `Tool refused: path "${violation.path}" ${violation.reason}; writeAllow=[${allowlist}]`;
        input.log(`${input.label}: tool refused: ${reason}`);
        return { block: true, reason };
      });
    },
  };
}

export async function toolWriteViolation(
  event: Pick<ToolCallEvent, "toolName" | "input">,
  policy: WriteAllowPolicy,
): Promise<WriteAllowViolation | undefined> {
  if (event.toolName === "edit" || event.toolName === "write") {
    const path = readStringProperty(event.input, "path");
    if (path === undefined) return { path: "<missing>", reason: "does not provide a valid path" };
    return await checkWriteTarget(path, policy, policy.workspaceRoot);
  }
  if (event.toolName !== "bash") return undefined;
  const command = readStringProperty(event.input, "command");
  if (command === undefined) return { path: "<unknown>", reason: "uses a bash command that could not be inspected" };
  return await findBashWriteViolation(command, policy);
}

export async function checkWriteTarget(
  rawPath: string,
  policy: WriteAllowPolicy,
  baseCwd = policy.workspaceRoot,
): Promise<WriteAllowViolation | undefined> {
  const displayPath = rawPath;
  const path = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  if (path.length === 0 || path.includes("\0")) return { path: displayPath, reason: "is not a valid path" };
  if (!isAbsolute(path) && hasParentSegment(path)) {
    return { path: displayPath, reason: "contains a refused '..' segment" };
  }

  const absolute = isAbsolute(path) ? resolve(path) : resolve(baseCwd, path);
  if (!isPathWithin(policy.workspaceRoot, absolute)) {
    return { path: displayPath, reason: `resolves outside workspace ${policy.workspaceRoot}` };
  }
  const canonical = await resolveThroughExistingAncestor(absolute);
  const canonicalRoot = await resolveThroughExistingAncestor(policy.workspaceRoot);
  if (!isPathWithin(canonicalRoot, canonical)) {
    return { path: displayPath, reason: `resolves through a symbolic link outside workspace ${policy.workspaceRoot}` };
  }

  const workspacePath = normalizeRelativePath(relative(policy.workspaceRoot, absolute));
  if (!policy.matchers.some((matcher) => matcher.test(workspacePath))) {
    return { path: displayPath, reason: `resolves to "${workspacePath}" outside the write allowlist` };
  }
  return undefined;
}

/** Best-effort shell scan. It intentionally fails closed for recognized writes with unknown targets. */
export async function findBashWriteViolation(
  command: string,
  policy: WriteAllowPolicy,
): Promise<WriteAllowViolation | undefined> {
  const tokens = tokenizeShell(command);
  let cwd = policy.workspaceRoot;
  let segment: string[] = [];

  const inspect = async (): Promise<WriteAllowViolation | undefined> => {
    if (segment.length === 0) return undefined;
    const redirect = await redirectViolation(segment, policy, cwd);
    if (redirect) return redirect;

    const executable = unwrapCommand(segment);
    if (executable.length === 0) return undefined;
    if (basenameCommand(executable[0]!) === "cd") {
      const destination = executable.find((token, index) => index > 0 && !token.startsWith("-"));
      if (destination && !containsOpaqueShellSyntax(destination)) {
        const changed = isAbsolute(destination) ? resolve(destination) : resolve(cwd, destination);
        cwd = changed;
      }
      return undefined;
    }

    const argv = executable;
    const command = basenameCommand(argv[0]!);
    if (!WRITE_COMMANDS.has(command)) return undefined;
    const mutation = mutationTargets(argv, cwd);
    for (const target of mutation.targets) {
      if (target === "<unknown>") {
        return { path: target, reason: `is modified by ${argv.slice(0, 2).join(" ")} but cannot be scoped safely` };
      }
      if (isOutputDevice(target) && command === "tee") continue;
      if (containsOpaqueShellSyntax(target)) continue;
      const violation = await checkWriteTarget(target, policy, mutation.cwd);
      if (violation) return violation;
    }
    return undefined;
  };

  for (const token of tokens) {
    if (!SHELL_SEPARATORS.has(token)) {
      segment.push(token);
      continue;
    }
    const violation = await inspect();
    if (violation) return violation;
    segment = [];
  }
  return await inspect();
}

interface MutationTargets {
  readonly targets: string[];
  readonly cwd: string;
}

function mutationTargets(argv: readonly string[], cwd: string): MutationTargets {
  const command = basenameCommand(argv[0] ?? "");
  if (command === "git") {
    const invocation = parseGitInvocation(argv.slice(1), cwd);
    return {
      targets: invocation.valid ? gitTargets(invocation.args) : ["<unknown>"],
      cwd: invocation.cwd,
    };
  }
  let targets: string[] = [];
  if (command === "tee") targets = positionalArguments(argv.slice(1), new Set(["-a", "--append", "-i", "--ignore-interrupts"]));
  else if (command === "mv" || command === "cp") targets = transferTargets(argv.slice(1));
  else if (command === "install") targets = installTargets(argv.slice(1));
  else if (command === "rm") {
    const positional = positionalArguments(argv.slice(1));
    targets = positional.length > 0 ? positional : ["<unknown>"];
  } else if (command === "sed") targets = sedTargets(argv.slice(1));
  else if (command === "dd") {
    targets = argv.slice(1).flatMap((token) => token.startsWith("of=") && token.length > 3 ? [token.slice(3)] : []);
  }
  return { targets, cwd };
}

function transferTargets(args: readonly string[]): string[] {
  const targetDirectory = optionValue(args, "-t", "--target-directory");
  if (targetDirectory) return [targetDirectory];
  const positional = positionalArguments(args);
  return positional.length >= 2 ? [positional.at(-1)!] : ["<unknown>"];
}

function installTargets(args: readonly string[]): string[] {
  const targetDirectory = optionValue(args, "-t", "--target-directory");
  if (targetDirectory) return [targetDirectory];
  const positional = positionalArguments(args);
  if (args.includes("-d") || args.includes("--directory")) return positional;
  return positional.length >= 2 ? [positional.at(-1)!] : ["<unknown>"];
}

function sedTargets(args: readonly string[]): string[] {
  if (!args.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place="))) return [];
  const positional: string[] = [];
  let scriptProvidedByOption = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (token === "-e" || token === "--expression" || token === "-f" || token === "--file") {
      scriptProvidedByOption = true;
      index++;
      continue;
    }
    if (token.startsWith("--expression=") || token.startsWith("--file=")) {
      scriptProvidedByOption = true;
      continue;
    }
    if (token.startsWith("-")) continue;
    positional.push(token);
  }
  if (!scriptProvidedByOption) positional.shift();
  return positional.length > 0 ? positional : ["<unknown>"];
}

interface ParsedGitInvocation {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly valid: boolean;
}

function parseGitInvocation(args: readonly string[], initialCwd: string): ParsedGitInvocation {
  let cwd = initialCwd;
  let workTree: string | undefined;
  let index = 0;
  while (index < args.length) {
    const token = args[index]!;
    if (token === "-C") {
      const value = args[index + 1];
      if (!value || containsOpaqueShellSyntax(value)) return { args: [], cwd, valid: false };
      cwd = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
      index += 2;
      continue;
    }
    if (token.startsWith("-C") && token.length > 2) {
      const value = token.slice(2);
      if (containsOpaqueShellSyntax(value)) return { args: [], cwd, valid: false };
      cwd = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
      index++;
      continue;
    }
    if (token === "--work-tree") {
      const value = args[index + 1];
      if (!value || containsOpaqueShellSyntax(value)) return { args: [], cwd: workTree ?? cwd, valid: false };
      workTree = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
      index += 2;
      continue;
    }
    if (token.startsWith("--work-tree=")) {
      const value = token.slice("--work-tree=".length);
      if (!value || containsOpaqueShellSyntax(value)) return { args: [], cwd: workTree ?? cwd, valid: false };
      workTree = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
      index++;
      continue;
    }
    if (token === "-c" || token === "--git-dir") {
      if (!args[index + 1]) return { args: [], cwd, valid: false };
      index += 2;
      continue;
    }
    if (token.startsWith("--git-dir=") || (token.startsWith("-c") && token.length > 2) || token.startsWith("-")) {
      index++;
      continue;
    }
    break;
  }
  return { args: args.slice(index), cwd: workTree ?? cwd, valid: true };
}

function gitTargets(args: readonly string[]): string[] {
  const subcommand = args[0];
  if (!subcommand) return [];
  const rest = args.slice(1);
  if (subcommand === "mv") return transferTargets(rest);
  if (subcommand === "rm") return positionalArguments(rest);
  if (subcommand === "clean") return gitCleanTargets(rest);
  if (subcommand === "checkout" || subcommand === "restore") {
    const paths = argumentsAfterDoubleDash(rest);
    return paths.length > 0 ? paths : ["<unknown>"];
  }
  if (subcommand === "apply" || subcommand === "stash") return ["<unknown>"];
  return [];
}

function gitCleanTargets(args: readonly string[]): string[] {
  const afterDoubleDash = argumentsAfterDoubleDash(args);
  if (afterDoubleDash.length > 0) return afterDoubleDash;
  const paths: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (token === "-e" || token === "--exclude") {
      if (!args[index + 1]) return ["<unknown>"];
      index++;
      continue;
    }
    if (token.startsWith("--exclude=") || token.startsWith("-e") && token.length > 2) continue;
    if (token.startsWith("-")) continue;
    paths.push(token);
  }
  return paths.length > 0 ? paths : ["."];
}

async function redirectViolation(
  tokens: readonly string[],
  policy: WriteAllowPolicy,
  cwd: string,
): Promise<WriteAllowViolation | undefined> {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const attached = /^(?:\d*|&)(>>?|>\|)(.+)$/.exec(token);
    if (attached?.[2]) {
      const target = attached[2];
      if (isOutputDevice(target)) continue;
      if (!containsOpaqueShellSyntax(target)) {
        const violation = await checkWriteTarget(target, policy, cwd);
        if (violation) return violation;
      }
      continue;
    }
    if (!/^(?:\d*|&)?(?:>|>>|>\|)$/.test(token)) continue;
    const target = tokens[index + 1];
    if (!target) return { path: "<unknown>", reason: "is an incomplete shell redirection" };
    if (isOutputDevice(target)) {
      index++;
      continue;
    }
    if (!containsOpaqueShellSyntax(target)) {
      const violation = await checkWriteTarget(target, policy, cwd);
      if (violation) return violation;
    }
    index++;
  }
  return undefined;
}

function unwrapCommand(input: readonly string[]): string[] {
  let tokens = input.filter((token) => !isRedirectionToken(token));
  while (tokens.length > 0) {
    const wrapper = basenameCommand(tokens[0]!);
    if (wrapper === "xargs") {
      tokens = unwrapXargs(tokens.slice(1));
      continue;
    }
    if (!WRAPPERS.has(wrapper)) break;
    tokens = stripWrapper(wrapper, tokens.slice(1));
  }
  return tokens;
}

function stripWrapper(wrapper: string, args: readonly string[]): string[] {
  let index = 0;
  let timeoutDurationConsumed = wrapper !== "timeout";
  while (index < args.length) {
    const token = args[index]!;
    if (token === "--") return args.slice(index + 1);
    if (wrapper === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index++;
      continue;
    }
    if (wrapper === "timeout" && !timeoutDurationConsumed && !token.startsWith("-")) {
      timeoutDurationConsumed = true;
      index++;
      continue;
    }
    if (!token.startsWith("-")) break;
    if (wrapperOptionTakesValue(wrapper, token)) index += 2;
    else index++;
  }
  return args.slice(index);
}

function unwrapXargs(args: readonly string[]): string[] {
  let index = 0;
  while (index < args.length) {
    const token = args[index]!;
    if (token === "--") return args.slice(index + 1);
    if (!token.startsWith("-")) return args.slice(index);
    if (["-a", "--arg-file", "-d", "--delimiter", "-E", "-I", "-L", "-n", "-P", "-s"].includes(token)) index += 2;
    else index++;
  }
  return [];
}

function wrapperOptionTakesValue(wrapper: string, token: string): boolean {
  if (wrapper === "sudo") return ["-u", "-g", "-h", "-p", "-C", "-T", "-R"].includes(token);
  if (wrapper === "env") return token === "-u" || token === "--unset" || token === "-C" || token === "--chdir";
  if (wrapper === "timeout") return token === "-k" || token === "--kill-after" || token === "-s" || token === "--signal";
  if (wrapper === "nice") return token === "-n" || token === "--adjustment";
  if (wrapper === "stdbuf") return token === "-i" || token === "-o" || token === "-e";
  return false;
}

function positionalArguments(args: readonly string[], flagsWithoutValues: ReadonlySet<string> = new Set()): string[] {
  const result: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("-")) {
      if (flagsWithoutValues.has(token)) continue;
      if (token === "-t" || token === "--target-directory") index++;
      continue;
    }
    result.push(token);
  }
  return result;
}

function optionValue(args: readonly string[], short: string, long: string): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (token === short || token === long) return args[index + 1];
    if (token.startsWith(`${long}=`)) return token.slice(long.length + 1);
    if (token.startsWith(short) && token.length > short.length) return token.slice(short.length);
  }
  return undefined;
}

function argumentsAfterDoubleDash(args: readonly string[]): string[] {
  const separator = args.indexOf("--");
  return separator < 0 ? [] : [...args.slice(separator + 1)];
}

function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  const push = () => {
    if (token.length > 0) tokens.push(token);
    token = "";
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && index + 1 < command.length) token += command[++index]!;
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      token += command[++index]!;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (["&&", "||", ">>", "<<", ">|"].includes(pair)) {
      push();
      tokens.push(pair);
      index++;
      continue;
    }
    if ([";", "|", ">", "<"].includes(char)) {
      push();
      tokens.push(char);
      continue;
    }
    token += char;
  }
  push();
  return tokens;
}

function normalizePattern(pattern: string): string {
  if (typeof pattern !== "string" || pattern.length === 0) throw new Error("writeAllow patterns must be non-empty strings");
  if (isAbsolute(pattern) || /^[A-Za-z]:[\\/]/.test(pattern)) {
    throw new Error(`writeAllow pattern must be workspace-relative: ${pattern}`);
  }
  if (hasParentSegment(pattern) || pattern.includes("\0")) {
    throw new Error(`writeAllow pattern must not contain '..' segments: ${pattern}`);
  }
  return pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index++;
        if (pattern[index + 1] === "/") {
          index++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(char);
  }
  if (pattern.endsWith("/**")) {
    const suffix = escapeRegExp("/") + ".*";
    if (source.endsWith(suffix)) source = `${source.slice(0, -suffix.length)}(?:/.*)?`;
  }
  return new RegExp(`^${source}$`);
}

async function resolveThroughExistingAncestor(path: string): Promise<string> {
  const missing: string[] = [];
  let current = path;
  while (true) {
    try {
      await lstat(current);
      const resolved = await realpath(current);
      return resolve(resolved, ...missing.reverse());
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = resolve(current, "..");
      if (parent === current) return path;
      missing.push(relative(parent, current));
      current = parent;
    }
  }
}

function normalizeRelativePath(path: string): string {
  if (path === "") return ".";
  return sep === "/" ? path : path.split(sep).join("/");
}

function hasParentSegment(path: string): boolean {
  return path.replaceAll("\\", "/").split("/").includes("..");
}

function isOutputDevice(value: string): boolean {
  return value === "/dev/null" || value === "/dev/stdout" || value === "/dev/stderr";
}

function containsOpaqueShellSyntax(value: string): boolean {
  return /[$`]/.test(value);
}

function basenameCommand(value: string): string {
  return value.replaceAll("\\", "/").split("/").at(-1) ?? value;
}

function isRedirectionToken(value: string): boolean {
  return /^(?:\d*|&)?(?:>|>>|>\|)$/.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
