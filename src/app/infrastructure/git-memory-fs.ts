type Entry =
  | { children: Set<string>; kind: "dir"; mtimeMs: number }
  | { data: Uint8Array; kind: "file"; mtimeMs: number }
  | { kind: "symlink"; mtimeMs: number; target: string };

const fsError = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(message), { code });

interface MemoryStats {
  readonly ctimeMs: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly size: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

const normalizePath = (input: string): string => {
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
};

const parentPath = (path: string): string => {
  const normalized = normalizePath(path);
  if (normalized === "/") {
    return "/";
  }

  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.length > 0 ? `/${parts.join("/")}` : "/";
};

const basename = (path: string): string =>
  normalizePath(path).split("/").findLast(Boolean) ?? "";

const memoryStatsFor = (entry: Entry): MemoryStats => ({
  get ctimeMs() {
    return entry.mtimeMs;
  },
  isDirectory: () => entry.kind === "dir",
  isFile: () => entry.kind === "file",
  isSymbolicLink: () => entry.kind === "symlink",
  get mode() {
    if (entry.kind === "file") {
      return 0o10_0644;
    }

    return entry.kind === "symlink" ? 0o12_0000 : 0o04_0000;
  },
  get mtimeMs() {
    return entry.mtimeMs;
  },
  get size() {
    if (entry.kind === "file") {
      return entry.data.byteLength;
    }

    return entry.kind === "symlink" ? entry.target.length : 0;
  },
});

const asPromise = <Value>(operation: () => Value): Promise<Value> =>
  // oxlint-disable-next-line promise/prefer-await-to-then -- Promise FS methods must convert sync throws into rejected promises without async/await noise per method.
  Promise.resolve().then(operation);

export class GitMemoryFS {
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

  lstat(path: string): Promise<MemoryStats> {
    return this.stat(path);
  }

  async mkdir(
    path: string,
    options?: number | { readonly recursive?: boolean }
  ): Promise<void> {
    const target = normalizePath(path);
    if (target === "/") {
      return;
    }

    const recursive =
      typeof options === "object" &&
      options !== null &&
      options.recursive === true;
    const parent = parentPath(target);

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
    this.requireDir(parent).children.add(basename(target));
  }

  readFile(
    path: string,
    options?: string | { readonly encoding?: string }
  ): Promise<string | Uint8Array> {
    return asPromise(() => {
      const entry = this.requireEntry(path);
      if (entry.kind === "dir") {
        throw fsError("EISDIR", `EISDIR: ${path}`);
      }

      const data =
        entry.kind === "symlink"
          ? this.encoder.encode(entry.target)
          : entry.data;
      const encoding =
        typeof options === "string" ? options : options?.encoding;
      return encoding === undefined ? data : this.decoder.decode(data);
    });
  }

  readdir(path: string): Promise<string[]> {
    return asPromise(() => [...this.requireDir(path).children].toSorted());
  }

  readlink(
    path: string,
    options?: string | { readonly encoding?: string }
  ): Promise<string | Uint8Array> {
    return asPromise(() => {
      const entry = this.requireEntry(path);
      if (entry.kind !== "symlink") {
        throw fsError("EINVAL", `EINVAL: ${path}`);
      }

      const encoding =
        typeof options === "string" ? options : options?.encoding;
      const data = this.encoder.encode(entry.target);
      return encoding === undefined ? data : entry.target;
    });
  }

  rmdir(path: string): Promise<void> {
    return asPromise(() => {
      const target = normalizePath(path);
      const entry = this.requireDir(target);
      if (entry.children.size > 0) {
        throw fsError("ENOTEMPTY", `ENOTEMPTY: ${path}`);
      }
      this.entries.delete(target);
      this.requireDir(parentPath(target)).children.delete(basename(target));
    });
  }

  stat(path: string): Promise<MemoryStats> {
    return asPromise(() => memoryStatsFor(this.requireEntry(path)));
  }

  async symlink(target: string, path: string): Promise<void> {
    const normalized = normalizePath(path);
    await this.mkdir(parentPath(normalized), { recursive: true });
    this.entries.set(normalized, { kind: "symlink", mtimeMs: 0, target });
    this.requireDir(parentPath(normalized)).children.add(basename(normalized));
  }

  unlink(path: string): Promise<void> {
    return asPromise(() => {
      const target = normalizePath(path);
      const entry = this.requireEntry(target);
      if (entry.kind === "dir") {
        throw fsError("EISDIR", `EISDIR: ${path}`);
      }
      this.entries.delete(target);
      this.requireDir(parentPath(target)).children.delete(basename(target));
    });
  }

  async writeFile(
    path: string,
    data: ArrayBuffer | string | Uint8Array
  ): Promise<void> {
    const target = normalizePath(path);
    await this.mkdir(parentPath(target), { recursive: true });
    let bytes: Uint8Array;
    if (typeof data === "string") {
      bytes = this.encoder.encode(data);
    } else {
      bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    }
    this.entries.set(target, { data: bytes, kind: "file", mtimeMs: 0 });
    this.requireDir(parentPath(target)).children.add(basename(target));
  }

  private requireDir(path: string): Extract<Entry, { kind: "dir" }> {
    const entry = this.requireEntry(path);
    if (entry.kind !== "dir") {
      throw fsError("ENOTDIR", `ENOTDIR: ${path}`);
    }

    return entry;
  }

  private requireEntry(path: string): Entry {
    const normalized = normalizePath(path);
    const entry = this.entries.get(normalized);
    if (entry === undefined) {
      throw fsError("ENOENT", `ENOENT: ${path}`);
    }

    return entry;
  }
}
