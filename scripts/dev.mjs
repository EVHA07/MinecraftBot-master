import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");

function loadEnvFile(filePath, env) {
  if (!existsSync(filePath)) return;

  const contents = readFileSync(filePath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (!key || key in env) continue;

    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }
}

function normalizeBasePath(basePath) {
  const value = (basePath ?? "/minecraft-bot/").trim();

  if (value === "") {
    throw new Error("WEB_BASE_PATH/BASE_PATH cannot be empty.");
  }

  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
}

function createLineWriter(stream, prefix) {
  let pending = "";

  return {
    write(chunk) {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";

      for (const line of lines) {
        stream.write(`${prefix} ${line}\n`);
      }
    },
    flush() {
      if (pending !== "") {
        stream.write(`${prefix} ${pending}\n`);
        pending = "";
      }
    },
  };
}

function createPnpmCommand(args) {
  const npmExecPath = process.env.npm_execpath;

  if (npmExecPath) {
    return {
      command: process.execPath,
      args: [npmExecPath, ...args],
    };
  }

  return {
    command: "pnpm",
    args,
  };
}

const fileEnv = {};
loadEnvFile(path.join(rootDir, ".env"), fileEnv);
loadEnvFile(path.join(rootDir, ".env.local"), fileEnv);

const sharedEnv = {
  ...fileEnv,
  ...process.env,
};

const apiPort = sharedEnv.API_PORT ?? sharedEnv.PORT ?? "8080";
const webPort = sharedEnv.WEB_PORT ?? "23418";
const webBasePath = normalizeBasePath(
  sharedEnv.WEB_BASE_PATH ?? sharedEnv.BASE_PATH,
);
const apiProxyTarget =
  sharedEnv.VITE_API_PROXY_TARGET ??
  sharedEnv.API_ORIGIN ??
  `http://127.0.0.1:${apiPort}`;

console.log(`[dev] API server    http://127.0.0.1:${apiPort}`);
console.log(`[dev] Web dashboard http://127.0.0.1:${webPort}${webBasePath}`);

const services = [
  {
    name: "api",
    color: "\u001b[36m",
    ...createPnpmCommand(["--filter", "@workspace/api-server", "run", "dev"]),
    env: {
      ...sharedEnv,
      NODE_ENV: sharedEnv.NODE_ENV ?? "development",
      API_PORT: apiPort,
      PORT: apiPort,
    },
  },
  {
    name: "web",
    color: "\u001b[35m",
    ...createPnpmCommand(["--filter", "@workspace/minecraft-bot", "run", "dev"]),
    env: {
      ...sharedEnv,
      NODE_ENV: sharedEnv.NODE_ENV ?? "development",
      WEB_PORT: webPort,
      PORT: webPort,
      WEB_BASE_PATH: webBasePath,
      BASE_PATH: webBasePath,
      VITE_API_PROXY_TARGET: apiProxyTarget,
    },
  },
];

let shuttingDown = false;
const children = services.map((service) => {
  const child = spawn(service.command, service.args, {
    cwd: rootDir,
    env: service.env,
    stdio: ["inherit", "pipe", "pipe"],
  });

  const label = `${service.color}[${service.name}]\u001b[0m`;
  const stdoutWriter = createLineWriter(process.stdout, label);
  const stderrWriter = createLineWriter(process.stderr, label);

  child.stdout.on("data", (chunk) => stdoutWriter.write(chunk));
  child.stderr.on("data", (chunk) => stderrWriter.write(chunk));
  child.stdout.on("end", () => stdoutWriter.flush());
  child.stderr.on("end", () => stderrWriter.flush());

  child.on("error", (err) => {
    if (shuttingDown) return;

    shuttingDown = true;
    console.error(`[dev] failed to start ${service.name}: ${err.message}`);

    for (const current of children) {
      if (!current.killed) {
        current.kill("SIGTERM");
      }
    }

    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;

    shuttingDown = true;
    const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    console.error(`[dev] ${service.name} exited with ${reason}`);

    for (const current of children) {
      if (!current.killed) {
        current.kill("SIGTERM");
      }
    }

    process.exitCode = typeof code === "number" ? code : 1;
  });

  return child;
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
