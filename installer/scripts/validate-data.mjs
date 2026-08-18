#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const dataRoot = process.env.OUTPUT_ITEMS_DATA_DIR || path.join(localAppData, "CodexOutputItems");
const dataFile = path.join(dataRoot, "data", "items.json");

if (!fs.existsSync(dataFile)) {
  process.stdout.write("OUTPUT_ITEMS_DATA=empty\n");
  process.exit(0);
}

try {
  const items = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  if (!Array.isArray(items)) throw new Error("items.json 根值必须是数组");
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`第 ${index + 1} 项不是对象`);
    if (typeof item.id !== "string" || !item.id) throw new Error(`第 ${index + 1} 项缺少 id`);
    if (typeof item.path !== "string" || !item.path) throw new Error(`第 ${index + 1} 项缺少 path`);
    if (item.versions !== undefined && !Array.isArray(item.versions)) throw new Error(`第 ${index + 1} 项 versions 不是数组`);
  }
  process.stdout.write(`OUTPUT_ITEMS_DATA=valid;items=${items.length}\n`);
} catch (error) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const modified = fs.statSync(dataFile).mtime.toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(path.dirname(dataFile), `items.corrupt-${modified}.json`);
  if (!fs.existsSync(backupPath)) fs.copyFileSync(dataFile, backupPath, fs.constants.COPYFILE_EXCL);
  throw new Error(`产出项历史数据校验失败，原文件未修改，备份位于 ${backupPath}：${error.message}`);
}
