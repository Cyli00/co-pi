import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CpiError } from "./protocol.js";

export const WINDOWS_SHELL = "C:\\Git\\bin\\bash.exe";
const exec = promisify(execFile);

export async function hasUv(): Promise<boolean> {
  try {
    const { stdout } = await exec("uv", ["--version"], { timeout: 5_000, windowsHide: true });
    return /^uv\s+\d+\./.test(stdout.trim());
  } catch { return false; }
}

export async function requireGitBash(): Promise<void> {
  try {
    const { stdout } = await exec(WINDOWS_SHELL, ["--noprofile", "--norc", "-c", "printf '%s\\n' \"$BASH_VERSION\"; git --version"], {
      timeout: 5_000, windowsHide: true,
    });
    if (!/^\d+\.\d+[^\r\n]*\r?\ngit version /m.test(stdout)) throw new Error();
  } catch { throw new CpiError("windows_git_bash_required"); }
}

export async function validateShell(settings: { shellPath?: string }, platform = process.platform): Promise<void> {
  if (platform !== "win32") return;
  if (settings.shellPath !== WINDOWS_SHELL) throw new CpiError("windows_shell_path_required");
  await requireGitBash();
}
