"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { validateConfig } = require("../src/config");
const root = path.resolve(__dirname, "..");
const files = ["index.js"];
for (const directory of ["src", "scripts", "test"]) {
  for (const file of fs.readdirSync(path.join(root, directory)))
    if (file.endsWith(".js")) files.push(`${directory}/${file}`);
}
for (const file of files) {
  const result = spawnSync(
    process.execPath,
    ["--check", path.join(root, file)],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(1);
}
validateConfig(
  JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8")),
  {},
);
console.log(
  `Syntax checked: ${files.length} files. Example configuration is valid.`,
);
