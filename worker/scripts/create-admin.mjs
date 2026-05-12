import { createHash, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";

const DB_NAME = process.env.D1_DATABASE_NAME || "rli-panel-db";
const ITERATIONS = 310000;

const email = normalizeEmail(await prompt("Email admin: "));
const password = await promptHidden("Contrasena admin: ");
const repeatPassword = await promptHidden("Repite la contrasena: ");

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  throw new Error("Email no valido.");
}

if (password !== repeatPassword) {
  throw new Error("Las contrasenas no coinciden.");
}

if (password.length < 12) {
  throw new Error("La contrasena debe tener al menos 12 caracteres.");
}

const salt = base64Url(randomBytes(16));
const hashBytes = pbkdf2Sync(password, Buffer.from(salt, "base64url"), ITERATIONS, 32, "sha256");
const passwordHash = `pbkdf2-sha256$${ITERATIONS}$${salt}$${base64Url(hashBytes)}`;
const now = new Date().toISOString();
const sql = `
INSERT INTO users (id, email, password_hash, password_salt, password_algorithm, role, active, created_at, updated_at)
VALUES ('${sqlEscape(randomUUID())}', '${sqlEscape(email)}', '${sqlEscape(passwordHash)}', '${sqlEscape(salt)}', 'pbkdf2-sha256', 'admin', 1, '${sqlEscape(now)}', '${sqlEscape(now)}')
ON CONFLICT(email) DO UPDATE SET
  password_hash = excluded.password_hash,
  password_salt = excluded.password_salt,
  password_algorithm = excluded.password_algorithm,
  role = 'admin',
  active = 1,
  updated_at = excluded.updated_at;
`;

const wrangler = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
execFileSync(wrangler, ["d1", "execute", DB_NAME, "--remote", "--command", sql], { stdio: "inherit" });
console.log("Admin creado o actualizado correctamente.");

function prompt(question) {
  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function promptHidden(question) {
  return new Promise((resolve) => {
    readline.emitKeypressEvents(input);
    const wasRaw = input.isRaw;
    if (input.isTTY) input.setRawMode(true);
    output.write(question);

    let value = "";
    const onKeypress = (char, key) => {
      if (key?.name === "return") {
        output.write("\n");
        input.off("keypress", onKeypress);
        if (input.isTTY) input.setRawMode(Boolean(wasRaw));
        resolve(value);
        return;
      }
      if (key?.name === "backspace") {
        value = value.slice(0, -1);
        return;
      }
      if (key?.ctrl && key.name === "c") {
        process.exit(1);
      }
      if (char) value += char;
    };

    input.on("keypress", onKeypress);
  });
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}
