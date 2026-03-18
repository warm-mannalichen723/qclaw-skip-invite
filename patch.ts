import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, cpSync, mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";

const isMac = platform() === "darwin";
const isWin = platform() === "win32";

if (!isMac && !isWin) {
  console.error("错误：仅支持 macOS 和 Windows 系统。");
  process.exit(1);
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

// Resolve install path per platform
async function findAppPath(): Promise<string> {
  if (isMac) return "/Applications/QClaw.app";
  // Windows: check common install paths
  const asarRelPath = "resources/app.asar";
  const candidates = [
    join(process.env.LOCALAPPDATA || "", "Programs/QClaw"),
    "C:\\Program Files\\QClaw",
    "C:\\Program Files (x86)\\QClaw",
  ];
  for (const p of candidates) {
    if (existsSync(join(p, asarRelPath))) return p;
  }
  console.log("未在默认路径找到 QClaw，请手动指定。");
  const input = await prompt("请输入 QClaw 安装路径: ");
  if (input && existsSync(join(input, asarRelPath))) return input;
  console.error(`错误：在 ${join(input || "<空>", asarRelPath)} 未找到 QClaw`);
  process.exit(1);
}

// Check Node version >= 22 (required by @electron/asar)
const nodeVersion = parseInt(process.versions.node.split(".")[0]);
if (nodeVersion < 22) {
  console.error(`错误：需要 Node >= 22（当前版本: ${process.versions.node}）`);
  process.exit(1);
}

(async () => {
  const APP_PATH = await findAppPath();
  const ASAR_PATH = isMac
    ? join(APP_PATH, "Contents/Resources/app.asar")
    : join(APP_PATH, "resources/app.asar");
  const ELECTRON_BIN = isMac
    ? join(APP_PATH, "Contents/Frameworks/Electron Framework.framework/Electron Framework")
    : join(APP_PATH, "QClaw.exe");

  // Stop QClaw if running
  let wasRunning = false;
  try {
    if (isMac) {
      execSync("pgrep -f QClaw", { stdio: "ignore" });
      wasRunning = true;
      console.log("==> 检测到 QClaw 正在运行，正在关闭...");
      try { execSync("pkill -f QClaw"); } catch {}
      execSync("sleep 1");
    } else {
      // Windows: check if process is running
      execSync("tasklist /FI \"IMAGENAME eq QClaw.exe\" | findstr QClaw.exe", { stdio: "ignore" });
      wasRunning = true;
      console.log("==> 检测到 QClaw 正在运行，正在关闭...");

      // Try to kill process with retry mechanism
      for (let i = 0; i < 3; i++) {
        try {
          execSync("taskkill /F /IM QClaw.exe", { stdio: "ignore" });
        } catch {}

        // Check if process is still running
        try {
          execSync("tasklist /FI \"IMAGENAME eq QClaw.exe\" | findstr QClaw.exe", { stdio: "ignore" });
          // Process still running, wait and retry
          execSync("powershell -Command \"Start-Sleep -Seconds 1\"");
        } catch {
          // Process not found, successfully killed
          break;
        }
      }

      // Wait for file handles to be released
      execSync("powershell -Command \"Start-Sleep -Seconds 1\"");
    }
  } catch {}

  // Create temp dir with cleanup
  const workDir = mkdtempSync(join(tmpdir(), "qclaw-patch-"));
  const cleanup = () => rmSync(workDir, { recursive: true, force: true });
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(1); });

  try {
    console.log("==> 正在解包应用资源...");
    execSync(`npx --yes @electron/asar extract "${ASAR_PATH}" "${join(workDir, "app")}"`, { stdio: "inherit" });

    const assetsDir = join(workDir, "app/out/renderer/assets");
    const jsFiles = readdirSync(assetsDir).filter(f => f.endsWith(".js"));

    // Find target file containing invite logic
    let targetFile = "";
    for (const file of jsFiles) {
      const content = readFileSync(join(assetsDir, file), "utf8");
      if (content.includes("inviteCodeVerified")) {
        targetFile = join(assetsDir, file);
        break;
      }
    }

    if (!targetFile) {
      console.error("错误：未找到邀请码验证逻辑，可能 QClaw 版本不兼容");
      process.exit(1);
    }

    console.log(`==> 定位到目标文件: ${basename(targetFile)}`);

    // Patch: set inviteVerified default to true
    let code = readFileSync(targetFile, "utf8");

    // Find the variable name mapped to inviteCodeVerified in the return object
    const retMatch = code.match(/inviteCodeVerified:(\w+)/);
    if (!retMatch) {
      console.error("错误：未找到邀请码验证入口，可能 QClaw 版本不兼容");
      process.exit(1);
    }
    const varName = retMatch[1];

    // Search backwards from the return statement with exponentially expanding range
    const retPos = code.indexOf(retMatch[0]);
    const refPattern = new RegExp(
      `((?<![a-zA-Z0-9_$])${varName}=\\w+\\()(!0|!1)(\\))`, "g"
    );

    let lastMatch: RegExpExecArray | null = null;
    let matchOffset = 0;
    for (let range = 10000; range <= retPos; range *= 2) {
      const searchStart = Math.max(0, retPos - range);
      const chunk = code.slice(searchStart, retPos);
      refPattern.lastIndex = 0;
      const matches = [...chunk.matchAll(refPattern)];
      if (matches.length > 0) {
        lastMatch = matches[matches.length - 1];
        matchOffset = searchStart + lastMatch.index!;
        break;
      }
      if (searchStart === 0) break;
    }

    if (!lastMatch) {
      console.error("错误：未找到邀请码初始化位置，可能 QClaw 版本不兼容");
      process.exit(1);
    }

    if (lastMatch[2] === "!0") {
      console.log("==> 已经补丁过了，跳过修改");
    } else {
      const patched = lastMatch[1] + "!0" + lastMatch[3];
      code = code.slice(0, matchOffset) + patched + code.slice(matchOffset + lastMatch[0].length);
      writeFileSync(targetFile, code);
      console.log("==> 修改成功：已跳过邀请码验证");
    }

    console.log("==> 正在重新打包...");
    execSync(`npx --yes @electron/asar pack "${join(workDir, "app")}" "${join(workDir, "app-patched.asar")}"`, { stdio: "inherit" });

    console.log("==> 正在替换应用资源...");
    cpSync(join(workDir, "app-patched.asar"), ASAR_PATH);

    // Disable Electron's asar integrity validation fuse (if enabled)
    const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
    const FUSE_ASAR_INTEGRITY_INDEX = 4;

    const bin = Buffer.from(readFileSync(ELECTRON_BIN));
    const sentinelPos = bin.indexOf(FUSE_SENTINEL);
    if (sentinelPos === -1) {
      console.error("错误：未找到完整性校验标记，可能 QClaw 版本不兼容");
      process.exit(1);
    }
    // Fuse wire: sentinel(32) + version(1) + count(1) + fuse_bytes(ascii '0'/'1')
    const fuseOffset = sentinelPos + FUSE_SENTINEL.length + 2 + FUSE_ASAR_INTEGRITY_INDEX;
    if (bin[fuseOffset] === 0x31) { // '1' = enabled
      bin[fuseOffset] = 0x30;       // '0' = disabled
      writeFileSync(ELECTRON_BIN, bin);
      console.log("==> 已关闭完整性校验");
    }

    // macOS: re-sign the app (required after modifying binary/asar)
    if (isMac) {
      console.log("==> 正在重新签名...");
      execSync(`codesign --remove-signature "${APP_PATH}"`, { stdio: "inherit" });
      execSync(`codesign --force --deep --sign - "${APP_PATH}"`, { stdio: "inherit" });
    }

    console.log("\n==> 补丁完成！请重新打开 QClaw 即可使用。");

    if (wasRunning) {
      console.log("==> 正在重新启动 QClaw...");
      if (isMac) {
        execSync(`open "${APP_PATH}"`);
      } else {
        execSync(`start "" "${join(APP_PATH, "QClaw.exe")}"`, { stdio: "ignore" });
      }
    }
  } catch (err: any) {
    if (isWin && err?.code === "EPERM") {
      console.error("\nERROR: 权限不足，无法写入 QClaw 安装目录。");
      console.error("请以管理员身份运行终端后重试：");
      console.error("  右键点击终端 → 以管理员身份运行 → 重新执行命令");
    } else {
      console.error(err);
    }
    process.exit(1);
  }
})();
