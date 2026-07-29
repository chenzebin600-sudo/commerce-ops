import { spawn } from "node:child_process";

const toastScript = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$nodes = $template.GetElementsByTagName('text')
$nodes.Item(0).AppendChild($template.CreateTextNode($env:ZNWX_TOAST_TITLE)) > $null
$nodes.Item(1).AppendChild($template.CreateTextNode($env:ZNWX_TOAST_MESSAGE)) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Windows.SystemToast.PowerShell').Show($toast)
`;
const encodedToastScript = Buffer.from(toastScript, "utf16le").toString("base64");

function notificationEnvironment(title, message) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(?:PASSWORD|TOKEN|SECRET|COOKIE|AUTHORIZATION)/i.test(key)) delete env[key];
  }
  env.ZNWX_TOAST_TITLE = String(title || "马帮自动发货").slice(0, 80);
  env.ZNWX_TOAST_MESSAGE = String(message || "").slice(0, 240);
  return env;
}

export function createWindowsNotifier({ enabled = false, platform = process.platform, spawnProcess = spawn, logger = console } = {}) {
  function start({ title, message }) {
    return spawnProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", encodedToastScript], {
      windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
      env: notificationEnvironment(title, message),
    });
  }
  return {
    notify({ title, message }) {
      if (!enabled || platform !== "win32") return false;
      const child = start({ title, message });
      let stderr = "";
      child.stderr?.on?.("data", (chunk) => { stderr += String(chunk).slice(0, 1000); });
      child.on?.("error", (error) => logger.error?.(`Windows notification failed: ${error.message}`));
      child.on?.("exit", (code) => { if (code) logger.error?.(`Windows notification exited ${code}: ${stderr.trim()}`); });
      child.unref?.();
      return true;
    },
    notifyAndWait({ title, message }) {
      if (!enabled || platform !== "win32") return Promise.resolve({ delivered: false, code: "NOTIFICATIONS_DISABLED" });
      return new Promise((resolve) => {
        const child = start({ title, message });
        let stderr = "";
        child.stderr?.on?.("data", (chunk) => { stderr += String(chunk).slice(0, 2000); });
        child.once("error", (error) => resolve({ delivered: false, code: "NOTIFICATION_PROCESS_FAILED", message: error.message }));
        child.once("exit", (code) => resolve(code === 0
          ? { delivered: true }
          : { delivered: false, code: "NOTIFICATION_COMMAND_FAILED", message: stderr.trim() || `PowerShell exit code ${code}` }));
      });
    },
  };
}
