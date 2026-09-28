"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function unitQuote(value, exec = false) {
  if (/[\r\n\0]/.test(value))
    throw new Error("Paths cannot contain control characters");
  let escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
  if (exec) escaped = escaped.replaceAll("$", () => "$$");
  return `"${escaped}"`;
}

function serviceUnit(root, node, user = null) {
  if (
    !path.posix.isAbsolute(root) ||
    /[\x00-\x1f\x7f]/.test(root) ||
    /[\s\\]$/.test(root)
  )
    throw new Error(
      "Service directory must be an absolute Linux path without control characters, trailing whitespace or a trailing backslash.",
    );
  if (user !== null && !/^[a-z_][a-z0-9_-]*[$]?$/.test(user))
    throw new Error("Invalid service user name.");
  return `[Unit]
Description=Twitch2Discord relay
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
${user ? `User=${user}\n` : ""}WorkingDirectory=${root.replaceAll("%", "%%")}
ExecStart=${unitQuote(node, true)} ${unitQuote(path.posix.join(root, "index.js"), true)} --config ${unitQuote(path.posix.join(root, "config.json"), true)}
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=15
TimeoutStopSec=40
KillMode=control-group
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=${user ? "multi-user.target" : "default.target"}
`;
}

function serviceOptions(args, uid) {
  const system = args[0] === "--system";
  if (
    args.length &&
    !(
      system &&
      (args.length === 1 ||
        (args.length === 3 &&
          args[1] === "--user" &&
          /^[a-z_][a-z0-9_-]*[$]?$/.test(args[2])))
    )
  )
    throw new Error(
      "Usage: npm run service:install [-- --system [--user ACCOUNT]]",
    );
  if (system && uid !== 0)
    throw new Error("System service installation requires root.");
  if (!system && uid === 0)
    throw new Error(
      "For root-managed hosts use: npm run service:install -- --system",
    );
  return { system, user: system ? args[2] || "root" : null };
}

function install(args = process.argv.slice(2)) {
  if (process.platform !== "linux")
    throw new Error("The service installer requires Linux with systemd.");
  const { system, user } = serviceOptions(args, process.getuid());
  const switchUser = system && user !== "root";
  if (switchUser) execFileSync("id", ["-u", user], { stdio: "ignore" });
  const root = fs.realpathSync(path.resolve(__dirname, ".."));
  execFileSync(
    switchUser ? "runuser" : process.execPath,
    [
      ...(switchUser ? ["-u", user, "--", process.execPath] : []),
      path.join(root, "index.js"),
      "--diagnose",
      "--config",
      path.join(root, "config.json"),
    ],
    { cwd: root, stdio: "inherit" },
  );
  const { loadConfig } = require("../src/config");
  const token = loadConfig(path.join(root, "config.json"), {}).token;
  if (!token || token === "PUT_NEW_TOKEN_HERE")
    throw new Error(
      "Set token in config.json before installing the service; a shell-only DISCORD_TOKEN is not inherited by systemd.",
    );
  const scope = system ? [] : ["--user"];
  execFileSync("systemctl", [...scope, "show-environment"], {
    stdio: "ignore",
  });
  const directory = system
    ? "/etc/systemd/system"
    : path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "systemd",
        "user",
      );
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "twitch2discord.service"),
    serviceUnit(root, process.execPath, user),
    { mode: system ? 0o644 : 0o600 },
  );
  execFileSync("systemctl", [...scope, "daemon-reload"], { stdio: "inherit" });
  execFileSync("systemctl", [...scope, "enable", "twitch2discord"], {
    stdio: "inherit",
  });
  execFileSync("systemctl", [...scope, "restart", "twitch2discord"], {
    stdio: "inherit",
  });
  console.log(
    `Service installed. Check: systemctl ${system ? "" : "--user "}status twitch2discord`,
  );
}

if (require.main === module) {
  try {
    install();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { serviceUnit, unitQuote, serviceOptions };
