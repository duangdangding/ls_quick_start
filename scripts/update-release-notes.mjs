// 用法: GH_TOKEN=xxx node scripts/update-release-notes.mjs <tag> <notesPath>
const [tag, notesPath] = process.argv.slice(2);
const repo = "duangdangding/ls_quick_start";
const headers = {
  Authorization: `Bearer ${process.env.GH_TOKEN}`,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
  "User-Agent": "suqi-release-script",
};

const relRes = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers });
if (!relRes.ok) {
  console.error("GET release failed:", relRes.status, await relRes.text());
  process.exit(1);
}
const rel = await relRes.json();

const body = (await import("fs")).readFileSync(notesPath, "utf-8");
const patchRes = await fetch(`https://api.github.com/repos/${repo}/releases/${rel.id}`, {
  method: "PATCH",
  headers,
  body: JSON.stringify({ body }),
});
if (!patchRes.ok) {
  console.error("PATCH failed:", patchRes.status, await patchRes.text());
  process.exit(1);
}

// 复核：重新 GET，确认 body 首尾完整、assets 数量
const verify = await (await fetch(`https://api.github.com/repos/${repo}/releases/${rel.id}`, { headers })).json();
const firstLine = verify.body.split("\n")[0];
const lastLine = verify.body.trimEnd().split("\n").pop();
console.log(JSON.stringify({
  id: verify.id,
  tag: verify.tag_name,
  bodyLen: verify.body.length,
  firstLine,
  lastLine,
  assets: verify.assets.map((a) => a.name),
}, null, 2));
