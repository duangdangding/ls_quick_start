// 更新指定 tag 的 GitHub Release notes，并回读校验（body 首尾 + assets 数量）
import fs from "node:fs";

const [tag, notesPath] = process.argv.slice(2);
const repo = "duangdangding/ls_quick_start";
const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "suqi-release" };

const rel = await (await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers })).json();
if (!rel.id) { console.error(`release not found for ${tag}:`, rel.message); process.exit(1); }

const body = fs.readFileSync(notesPath, "utf-8");
const patched = await (await fetch(`https://api.github.com/repos/${repo}/releases/${rel.id}`, { method: "PATCH", headers, body: JSON.stringify({ body }) })).json();
if (!patched.id) { console.error(`patch failed for ${tag}:`, patched.message); process.exit(1); }

// 回读核对：body 首尾完整、assets 数量
const check = await (await fetch(`https://api.github.com/repos/${repo}/releases/${rel.id}`, { headers })).json();
const lines = check.body.split(/\r?\n/).filter(Boolean);
console.log(`tag: ${check.tag_name}`);
console.log(`assets: ${check.assets.length} -> ${check.assets.map((a) => a.name).join(", ")}`);
console.log(`body head: ${lines[0]}`);
console.log(`body tail: ${lines[lines.length - 1]}`);
console.log(`body intact: ${check.body.trim() === body.trim()}`);
