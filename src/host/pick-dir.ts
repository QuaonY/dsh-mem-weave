/**
 * 忆织 MemWeave —— 系统“选择文件夹”对话框（宿主侧）
 *
 * 浏览器里的 <input type=file webkitdirectory> 拿不到绝对路径，所以由宿主弹系统对话框：
 * Windows 用 FolderBrowserDialog（PowerShell），macOS 用 osascript，Linux 用 zenity / kdialog。
 * 用户取消返回 E_CANCEL；系统不支持时返回 E_UNAVAILABLE，界面回退到手动输入。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export type PickDirResult =
  | { ok: true; dir: string }
  | { ok: false; code: "E_CANCEL" | "E_UNAVAILABLE"; message: string };

const TIMEOUT_MS = 10 * 60 * 1000;

function run(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    let child: ReturnType<typeof spawn>;
    try {
      // windowsHide 只隐藏 PowerShell 的控制台黑框，文件夹对话框照常显示
      child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 忽略
      }
      done(null);
    }, TIMEOUT_MS);
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (e) => {
      stderr += String(e);
      done(-1);
    });
    child.on("close", (code) => done(code));
  });
}

/** Windows：结果用 Base64(UTF-8) 输出，避开控制台代码页把中文路径弄乱 */
function windowsScript(initial: string): string {
  const init = initial.replace(/'/g, "''");
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "[System.Windows.Forms.Application]::EnableVisualStyles()",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$owner.ShowInTaskbar = $false",
    "$owner.WindowState = 'Minimized'",
    "$owner.Show() | Out-Null",
    "$owner.Hide()",
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$d.Description = '选择存放人格与记忆库的文件夹'",
    "$d.ShowNewFolderButton = $true",
    init ? "if (Test-Path -LiteralPath '" + init + "') { $d.SelectedPath = '" + init + "' }" : "",
    "$r = $d.ShowDialog($owner)",
    "$owner.Dispose()",
    "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($d.SelectedPath)) } else { 'CANCEL' }",
  ].filter(Boolean).join("\n");
}

export async function pickDirectory(initial = ""): Promise<PickDirResult> {
  const unavailable = (why: string): PickDirResult => ({
    ok: false,
    code: "E_UNAVAILABLE",
    message: "无法打开系统文件夹选择框（" + why + "），请直接填写路径",
  });
  const cancel: PickDirResult = { ok: false, code: "E_CANCEL", message: "已取消" };
  const start = initial && existsSync(initial) ? initial : "";

  if (process.platform === "win32") {
    const encoded = Buffer.from(windowsScript(start), "utf16le").toString("base64");
    const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded]);
    if (out.code === null) return cancel;
    const text = out.stdout.trim();
    if (out.code !== 0 || !text) return unavailable(out.stderr.trim().split("\n")[0] || "powershell 退出码 " + String(out.code));
    if (text === "CANCEL") return cancel;
    try {
      const dir = Buffer.from(text, "base64").toString("utf8").trim();
      return dir ? { ok: true, dir } : cancel;
    } catch {
      return unavailable("返回值无法解析");
    }
  }

  if (process.platform === "darwin") {
    const script = 'POSIX path of (choose folder with prompt "选择存放人格与记忆库的文件夹"' +
      (start ? ' default location (POSIX file "' + start.replace(/"/g, '\\"') + '")' : "") + ")";
    const out = await run("osascript", ["-e", script]);
    if (out.code === 0 && out.stdout.trim()) return { ok: true, dir: out.stdout.trim().replace(/\/$/, "") };
    if (/-128|User canceled/i.test(out.stderr)) return cancel;
    return out.code === null ? cancel : unavailable(out.stderr.trim() || "osascript 失败");
  }

  const tries: Array<[string, string[]]> = [
    ["zenity", ["--file-selection", "--directory", "--title=选择存放人格与记忆库的文件夹", ...(start ? ["--filename=" + start + "/"] : [])]],
    ["kdialog", ["--getexistingdirectory", start || "~"]],
  ];
  for (const [cmd, args] of tries) {
    const out = await run(cmd, args);
    if (out.code === -1) continue; // 没装这个工具
    if (out.code === 0 && out.stdout.trim()) return { ok: true, dir: out.stdout.trim() };
    return cancel;
  }
  return unavailable("没有找到 zenity 或 kdialog");
}
