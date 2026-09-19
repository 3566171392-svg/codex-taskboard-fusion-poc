/**
 * Trust the demo workspace inside the isolated CODEX_HOME used by the demo.
 *
 * Writes only to the isolated home (default D:\poc\v2-codex-home).
 * It never touches the user's real CODEX_HOME: `thread/start` persists project
 * trust, so pointing the app server at the real home would modify it.
 */
import fs from "node:fs/promises";

const home = process.env.FUSION_POC_CODEX_HOME ?? "D:\\poc\\v2-codex-home";
const workspace = process.env.FUSION_POC_WORKSPACE ?? "D:\\poc\\gate-demo";

if (!home.toLowerCase().startsWith("d:\\poc\\")) {
  console.error(`refusing to modify a CODEX_HOME outside D:\\poc: ${home}`);
  process.exit(2);
}

const configPath = `${home}\\config.toml`;
const config = await fs.readFile(configPath, "utf8");
const key = workspace.toLowerCase();

if (config.toLowerCase().includes(`[projects.'${key}']`)) {
  console.log(JSON.stringify({ home, workspace, alreadyTrusted: true }, null, 2));
} else {
  await fs.writeFile(configPath, `${config.trimEnd()}\n\n[projects.'${key}']\ntrust_level = "trusted"\n`, "utf8");
  const after = await fs.readFile(configPath, "utf8");
  console.log(JSON.stringify({ home, workspace, alreadyTrusted: false, verified: after.toLowerCase().includes(`[projects.'${key}']`) }, null, 2));
}
