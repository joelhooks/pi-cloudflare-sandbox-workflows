/* eslint-disable class-methods-use-this, max-classes-per-file, no-nested-ternary, require-await, unicorn/prefer-array-find */

// Compatibility shim for isomorphic-git in Workers. Methods intentionally mimic fs.promises.
type Entry =
  | { children: Set<string>; kind: "dir"; mtimeMs: number }
  | { data: Uint8Array; kind: "file"; mtimeMs: number }
  | { kind: "symlink"; mtimeMs: number; target: string };

const fsError = (code: string, message: string): Error & { code: string } => {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
};

class MemoryStats {
  private readonly entry: Entry;

  constructor(entry: Entry) {
    this.entry = entry;
  }

  get ctimeMs(): number {
    return this.entry.mtimeMs;
  }

  get mode(): number {
    if (this.entry.kind === "file") {
      return 0o10_0644;
    }
    return this.entry.kind === "symlink" ? 0o12_0000 : 0o04_0000;
  }

  get mtimeMs(): number {
    return this.entry.mtimeMs;
  }

  get size(): number {
    if (this.entry.kind === "file") {
      return this.entry.data.byteLength;
    }
    return this.entry.kind === "symlink" ? this.entry.target.length : 0;
  }

  isDirectory(): boolean {
    return this.entry.kind === "dir";
  }

  isFile(): boolean {
    return this.entry.kind === "file";
  }

  isSymbolicLink(): boolean {
    return this.entry.kind === "symlink";
  }
}

export class MemoryFS {
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly entries = new Map<string, Entry>([
    ["/", { children: new Set<string>(), kind: "dir", mtimeMs: 0 }],
  ]);

  readonly promises = {
    lstat: this.lstat.bind(this),
    mkdir: this.mkdir.bind(this),
    readFile: this.readFile.bind(this),
    readdir: this.readdir.bind(this),
    readlink: this.readlink.bind(this),
    rmdir: this.rmdir.bind(this),
    stat: this.stat.bind(this),
    symlink: this.symlink.bind(this),
    unlink: this.unlink.bind(this),
    writeFile: this.writeFile.bind(this),
  };

  async lstat(path: string): Promise<MemoryStats> {
    return this.stat(path);
  }

  async mkdir(
    path: string,
    options?: number | { recursive?: boolean }
  ): Promise<void> {
    const target = this.normalize(path);
    if (target === "/") {
      return;
    }

    const recursive =
      typeof options === "object" && options !== null && options.recursive;
    const parent = this.parent(target);

    if (!this.entries.has(parent)) {
      if (!recursive) {
        throw fsError("ENOENT", `ENOENT: ${parent}`);
      }
      await this.mkdir(parent, { recursive: true });
    }

    if (this.entries.has(target)) {
      return;
    }

    this.entries.set(target, {
      children: new Set<string>(),
      kind: "dir",
      mtimeMs: 0,
    });
    this.requireDir(parent).children.add(this.basename(target));
  }

  async readFile(
    path: string,
    options?: string | { encoding?: string }
  ): Promise<string | Uint8Array> {
    const entry = this.requireEntry(path);
    if (entry.kind === "dir") {
      throw fsError("EISDIR", `EISDIR: ${path}`);
    }

    const data =
      entry.kind === "symlink" ? this.encoder.encode(entry.target) : entry.data;
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? this.decoder.decode(data) : data;
  }

  async readdir(path: string): Promise<string[]> {
    return [...this.requireDir(path).children].toSorted();
  }

  async readlink(
    path: string,
    options?: string | { encoding?: string }
  ): Promise<string | Uint8Array> {
    const entry = this.requireEntry(path);
    if (entry.kind !== "symlink") {
      throw fsError("EINVAL", `EINVAL: ${path}`);
    }

    const encoding = typeof options === "string" ? options : options?.encoding;
    const data = this.encoder.encode(entry.target);
    return encoding ? entry.target : data;
  }

  async rmdir(path: string): Promise<void> {
    const target = this.normalize(path);
    const entry = this.requireDir(target);
    if (entry.children.size > 0) {
      throw fsError("ENOTEMPTY", `ENOTEMPTY: ${path}`);
    }
    this.entries.delete(target);
    this.requireDir(this.parent(target)).children.delete(this.basename(target));
  }

  async stat(path: string): Promise<MemoryStats> {
    return new MemoryStats(this.requireEntry(path));
  }

  async symlink(target: string, path: string): Promise<void> {
    const normalized = this.normalize(path);
    await this.mkdir(this.parent(normalized), { recursive: true });
    this.entries.set(normalized, { kind: "symlink", mtimeMs: 0, target });
    this.requireDir(this.parent(normalized)).children.add(
      this.basename(normalized)
    );
  }

  async unlink(path: string): Promise<void> {
    const target = this.normalize(path);
    const entry = this.requireEntry(target);
    if (entry.kind === "dir") {
      throw fsError("EISDIR", `EISDIR: ${path}`);
    }
    this.entries.delete(target);
    this.requireDir(this.parent(target)).children.delete(this.basename(target));
  }

  async writeFile(
    path: string,
    data: ArrayBuffer | string | Uint8Array
  ): Promise<void> {
    const target = this.normalize(path);
    await this.mkdir(this.parent(target), { recursive: true });
    const bytes =
      typeof data === "string"
        ? this.encoder.encode(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data);
    this.entries.set(target, { data: bytes, kind: "file", mtimeMs: 0 });
    this.requireDir(this.parent(target)).children.add(this.basename(target));
  }

  private basename(path: string): string {
    return this.normalize(path).split("/").filter(Boolean).pop() ?? "";
  }

  private normalize(input: string): string {
    const segments: string[] = [];
    for (const part of input.split("/")) {
      if (!part || part === ".") {
        continue;
      }
      if (part === "..") {
        segments.pop();
        continue;
      }
      segments.push(part);
    }

    return segments.length > 0 ? `/${segments.join("/")}` : "/";
  }

  private parent(path: string): string {
    const normalized = this.normalize(path);
    if (normalized === "/") {
      return "/";
    }

    const parts = normalized.split("/").filter(Boolean);
    parts.pop();
    return parts.length > 0 ? `/${parts.join("/")}` : "/";
  }

  private requireDir(path: string): Extract<Entry, { kind: "dir" }> {
    const entry = this.requireEntry(path);
    if (entry.kind !== "dir") {
      throw fsError("ENOTDIR", `ENOTDIR: ${path}`);
    }

    return entry;
  }

  private requireEntry(path: string): Entry {
    const entry = this.entries.get(this.normalize(path));
    if (!entry) {
      throw fsError("ENOENT", `ENOENT: ${path}`);
    }
    return entry;
  }
}
