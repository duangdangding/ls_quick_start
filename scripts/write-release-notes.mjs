import { readFileSync } from "node:fs";
const [tag, notesPath] = process.argv.slice(2);
const repo = "duangdangding/ls_quick_start";
const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "suqi-release" };
const rel = await (await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers })).json();
if (!rel.id) { console.error("release not found:", JSON.stringify(rel).slice(0, 200)); process.exit(1); }
const body = readFileSync(notesPath, "utf-8");
const res = await fetch(`https://api.github.com/repos/${repo}/releases/${rel.id}`, { method: "PATCH", headers, body: JSON.stringify({ body }) });
console.log("PATCH status:", res.status);
