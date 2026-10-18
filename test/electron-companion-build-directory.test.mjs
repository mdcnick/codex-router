import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(context) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router build directory "));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const checkout = path.join(directory, "checkout");
  const app = path.join(checkout, "apps", "control-center");
  const tools = path.join(directory, "tools");
  const caller = path.join(directory, "unrelated caller");
  const live = path.join(app, "release", "linux-unpacked");
  for (const entry of [path.join(checkout, "scripts"), path.join(app, "node_modules", ".bin"), tools, caller, live]) {
    mkdirSync(entry, { recursive: true });
  }
  const script = path.join(checkout, "scripts", "build-electron-companion.sh");
  writeFileSync(script, readFileSync(path.join(root, "scripts", "build-electron-companion.sh")));
  writeFileSync(path.join(live, "identity"), "previous package");
  const executable = (file, content) => writeFileSync(file, content, { mode: 0o700 });
  executable(path.join(tools, "node"), "#!/bin/sh\nexit 0\n");
  executable(path.join(tools, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n");
  executable(path.join(tools, "npm"), `#!/bin/sh
set -eu
[ "$PWD" = "$ROUTER_TEST_APP" ] || exit 70
printf '%s\\n' "$*" >> "$ROUTER_TEST_NPM_LOG"
`);
  executable(path.join(app, "node_modules", ".bin", "electron-builder"), `#!/bin/sh
set -eu
printf '%s\\n' "$PWD" > "$ROUTER_TEST_BUILDER_CWD"
[ "$PWD" = "$ROUTER_TEST_APP" ] || { printf 'wrong builder cwd\\n' >&2; exit 71; }
[ "$CSC_IDENTITY_AUTO_DISCOVERY" = false ] || exit 72
[ "$1" = --linux ] && [ "$2" = dir ] && [ "$3" = --publish ] && [ "$4" = never ] || exit 73
output=
for argument in "$@"; do
  case "$argument" in --config.directories.output=*) output=\${argument#*=} ;; esac
done
[ -n "$output" ] || exit 74
mkdir -p "$output/linux-unpacked/resources"
printf '#!/bin/sh\\nexit 0\\n' > "$output/linux-unpacked/codex-router-control-center"
chmod 700 "$output/linux-unpacked/codex-router-control-center"
exit "$ROUTER_TEST_BUILDER_STATUS"
`);
  const destination = path.join(app, "release", "staged package");
  const cwdLog = path.join(directory, "builder-cwd");
  const npmLog = path.join(directory, "npm-log");
  return {
    app, checkout, live, destination, cwdLog, npmLog,
    run(status, cwd = caller) {
      return spawnSync("sh", [script, "--stage-only", destination], {
        cwd, encoding: "utf8", timeout: 10_000,
        env: {
          PATH: `${tools}:/usr/bin:/bin`,
          ROUTER_TEST_APP: app,
          ROUTER_TEST_NPM_LOG: npmLog,
          ROUTER_TEST_BUILDER_CWD: cwdLog,
          ROUTER_TEST_BUILDER_STATUS: String(status),
        },
      });
    },
  };
}

for (const caller of ["repository root", "unrelated directory"]) {
  test(`Linux packaging uses the companion directory from ${caller}`, { skip: process.platform === "win32" }, (context) => {
    const item = fixture(context);
    const result = item.run(0, caller === "repository root" ? item.checkout : undefined);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(readFileSync(item.cwdLog, "utf8").trim(), item.app);
    assert.deepEqual(readFileSync(item.npmLog, "utf8").trim().split("\n"), ["ci", "run check", "test", "run build"]);
    assert.equal(result.stdout.trim(), path.join(item.destination, "codex-router-control-center"));
    assert.equal(readFileSync(path.join(item.destination, "resources", "router-root"), "utf8").trim(), item.checkout);
    assert.equal(readFileSync(path.join(item.live, "identity"), "utf8"), "previous package");
    assert.deepEqual(readdirSync(item.app).filter((name) => name.startsWith(".control-center-build.")), []);
  });
}

test("Linux builder failure preserves the live package and cleans partial staging", { skip: process.platform === "win32" }, (context) => {
  const item = fixture(context);
  const result = item.run(42);
  assert.equal(result.status, 42, result.stderr || result.error?.message);
  assert.equal(readFileSync(item.cwdLog, "utf8").trim(), item.app);
  assert.equal(result.stdout, "");
  assert.equal(existsSync(item.destination), false);
  assert.equal(readFileSync(path.join(item.live, "identity"), "utf8"), "previous package");
  assert.deepEqual(readdirSync(item.app).filter((name) => name.startsWith(".control-center-build.")), []);
});
