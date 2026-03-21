import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export interface HostKeyVerificationResult {
  verified: boolean;
  reason: string;
}

interface KnownHost {
  hostname: string;
  keyType: string;
  publicKey: string;
}

export class HostKeyVerifier {
  private knownHosts: KnownHost[] = [];
  private readonly knownHostsPath: string;
  private readonly trustOnFirstUse: boolean;

  constructor(knownHostsPath: string, trustOnFirstUse: boolean) {
    this.knownHostsPath = knownHostsPath;
    this.trustOnFirstUse = trustOnFirstUse;
    this.loadKnownHosts();
  }

  private loadKnownHosts(): void {
    if (!fs.existsSync(this.knownHostsPath)) return;
    const content = fs.readFileSync(this.knownHostsPath, "utf-8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("@")) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 3) continue;
      const hostnames = parts[0].split(",");
      for (const hostname of hostnames) {
        this.knownHosts.push({ hostname, keyType: parts[1], publicKey: parts[2] });
      }
    }
  }

  private hostnameMatches(entry: string, hostname: string): boolean {
    if (entry.startsWith("|1|")) {
      const parts = entry.split("|");
      if (parts.length < 4) return false;
      const salt = Buffer.from(parts[2], "base64");
      const storedHash = parts[3];
      const computedHash = crypto
        .createHmac("sha1", salt)
        .update(hostname)
        .digest("base64");
      return computedHash === storedHash;
    }
    return entry === hostname;
  }

  private findKnownKeys(hostname: string): KnownHost[] {
    return this.knownHosts.filter((entry) =>
      this.hostnameMatches(entry.hostname, hostname),
    );
  }

  private addKnownHost(
    hostname: string,
    keyType: string,
    publicKeyBase64: string,
  ): boolean {
    try {
      const dir = path.dirname(this.knownHostsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const line = `${hostname} ${keyType} ${publicKeyBase64}\n`;
      fs.appendFileSync(this.knownHostsPath, line, "utf-8");
      this.knownHosts.push({ hostname, keyType, publicKey: publicKeyBase64 });
      console.error(
        `[SSH] Host key for '${hostname}' accepted on first use and saved to ${this.knownHostsPath}`,
      );
      return true;
    } catch {
      return false;
    }
  }

  verifyHostKey(
    hostname: string,
    port: number,
    keyType: string,
    publicKey: Buffer,
  ): HostKeyVerificationResult {
    const displayHost = port === 22 ? hostname : `[${hostname}]:${port}`;
    const lookupKeys = port === 22 ? [hostname] : [`[${hostname}]:${port}`, hostname];

    let knownKeys: KnownHost[] = [];
    for (const lookupKey of lookupKeys) {
      knownKeys = this.findKnownKeys(lookupKey);
      if (knownKeys.length > 0) break;
    }

    const publicKeyBase64 = publicKey.toString("base64");

    if (knownKeys.length === 0) {
      if (this.trustOnFirstUse) {
        const saved = this.addKnownHost(displayHost, keyType, publicKeyBase64);
        if (saved) {
          return {
            verified: true,
            reason: "Host key accepted on first use and saved to known_hosts",
          };
        }
        return {
          verified: false,
          reason: `Failed to save host key for '${displayHost}'`,
        };
      }
      return {
        verified: false,
        reason: `UNKNOWN HOST: '${displayHost}' not found in known_hosts.\nTo add it, run: ssh-keyscan -H ${hostname} >> ${this.knownHostsPath}`,
      };
    }

    for (const known of knownKeys) {
      if (known.keyType === keyType && known.publicKey === publicKeyBase64) {
        return { verified: true, reason: `Host key verified for '${displayHost}'` };
      }
    }

    return {
      verified: false,
      reason: `HOST KEY MISMATCH for '${displayHost}'!\nServer presented: ${keyType}\nThis could indicate a man-in-the-middle attack.\nIf the server was legitimately re-keyed, remove the old entry:\n  ssh-keygen -R ${hostname}\nThen add the new key:\n  ssh-keyscan -H ${hostname} >> ${this.knownHostsPath}`,
    };
  }
}
