import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { HostKeyVerifier } from "../src/host-key-verifier.js";

function writeTempKnownHosts(content: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hkv-"));
  const filePath = path.join(tmpDir, "known_hosts");
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("HostKeyVerifier", () => {
  it("should verify known host key", () => {
    const publicKey = Buffer.from("test-public-key-data");
    const base64Key = publicKey.toString("base64");
    const filePath = writeTempKnownHosts(`example.com ssh-rsa ${base64Key}\n`);
    const verifier = new HostKeyVerifier(filePath, true);
    const result = verifier.verifyHostKey("example.com", 22, "ssh-rsa", publicKey);
    expect(result.verified).toBe(true);
  });

  it("should accept unknown host when TOFU enabled", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hkv-"));
    const filePath = path.join(tmpDir, "known_hosts");
    fs.writeFileSync(filePath, "", "utf-8");
    const verifier = new HostKeyVerifier(filePath, true);
    const publicKey = Buffer.from("new-host-key");
    const result = verifier.verifyHostKey("newhost.com", 22, "ssh-ed25519", publicKey);
    expect(result.verified).toBe(true);
    expect(result.reason).toContain("first use");
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("newhost.com");
  });

  it("should reject unknown host when TOFU disabled", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hkv-"));
    const filePath = path.join(tmpDir, "known_hosts");
    fs.writeFileSync(filePath, "", "utf-8");
    const verifier = new HostKeyVerifier(filePath, false);
    const publicKey = Buffer.from("new-host-key");
    const result = verifier.verifyHostKey("newhost.com", 22, "ssh-ed25519", publicKey);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("UNKNOWN HOST");
  });

  it("should reject mismatched host key", () => {
    const originalKey = Buffer.from("original-key");
    const base64Key = originalKey.toString("base64");
    const filePath = writeTempKnownHosts(`example.com ssh-rsa ${base64Key}\n`);
    const verifier = new HostKeyVerifier(filePath, true);
    const differentKey = Buffer.from("different-key");
    const result = verifier.verifyHostKey("example.com", 22, "ssh-rsa", differentKey);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("MISMATCH");
  });

  it("should handle non-default port in known_hosts", () => {
    const publicKey = Buffer.from("test-key");
    const base64Key = publicKey.toString("base64");
    const filePath = writeTempKnownHosts(`[example.com]:2222 ssh-rsa ${base64Key}\n`);
    const verifier = new HostKeyVerifier(filePath, true);
    const result = verifier.verifyHostKey("example.com", 2222, "ssh-rsa", publicKey);
    expect(result.verified).toBe(true);
  });

  it("should handle hashed known_hosts entries", () => {
    const publicKey = Buffer.from("test-key");
    const base64Key = publicKey.toString("base64");
    const salt = crypto.randomBytes(20);
    const hash = crypto.createHmac("sha1", salt).update("example.com").digest("base64");
    const hashedEntry = `|1|${salt.toString("base64")}|${hash}`;
    const filePath = writeTempKnownHosts(`${hashedEntry} ssh-rsa ${base64Key}\n`);
    const verifier = new HostKeyVerifier(filePath, true);
    const result = verifier.verifyHostKey("example.com", 22, "ssh-rsa", publicKey);
    expect(result.verified).toBe(true);
  });

  it("should create known_hosts file if it does not exist", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hkv-"));
    const filePath = path.join(tmpDir, "subdir", "known_hosts");
    const verifier = new HostKeyVerifier(filePath, true);
    const publicKey = Buffer.from("new-key");
    const result = verifier.verifyHostKey("newhost.com", 22, "ssh-rsa", publicKey);
    expect(result.verified).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
  });
});
