import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const source = path.join(projectRoot, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
const destDir = path.join(projectRoot, "public");
const dest = path.join(destDir, "sql-wasm.wasm");

try {
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(source, dest);
  console.log("Copied sql-wasm.wasm -> public/sql-wasm.wasm");
} catch (err) {
  console.warn(
    "Could not copy sql-wasm.wasm. If you plan to import .apkg, ensure sql-wasm.wasm is available at /public/sql-wasm.wasm",
    err
  );
}
