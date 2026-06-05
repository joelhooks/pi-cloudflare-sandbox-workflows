/* eslint-disable func-style, import/consistent-type-specifier-style, no-use-before-define */
import { clone } from "isomorphic-git";
import http from "isomorphic-git/http/web";

import type { FilesRefResolver } from "../core/files-ref-resolver.ts";
import {
  ResolvedFilesPayloadSchema,
  type ResolvedFilesPayload,
} from "../core/schemas.ts";
import { MemoryFS } from "../memory-fs.ts";

export interface ArtifactsFilesRefResolverOptions {
  artifactRemote: string;
  artifactTokenSecret: string;
}

export class ArtifactsFilesRefResolver implements FilesRefResolver {
  private readonly options: ArtifactsFilesRefResolverOptions;

  constructor(options: ArtifactsFilesRefResolverOptions) {
    this.options = options;
  }

  async resolve(filesRef: string): Promise<ResolvedFilesPayload> {
    const parsed = parseArtifactsFilesRef(filesRef);
    const fs = new MemoryFS();
    const dir = "/repo";
    await clone({
      depth: 1,
      dir,
      fs,
      http,
      onAuth: () => ({
        password: this.options.artifactTokenSecret,
        username: "x",
      }),
      singleBranch: true,
      url: this.options.artifactRemote,
    });
    const payload = await fs.promises.readFile(`${dir}/${parsed.payloadPath}`, {
      encoding: "utf-8",
    });
    return ResolvedFilesPayloadSchema.parse(JSON.parse(String(payload)));
  }
}

function parseArtifactsFilesRef(filesRef: string): { payloadPath: string } {
  if (!filesRef.startsWith("artifacts:")) {
    throw new Error("unsupported_files_ref");
  }
  const payloadPath = filesRef.slice("artifacts:".length);
  if (
    !payloadPath ||
    payloadPath.includes("..") ||
    payloadPath.startsWith("/")
  ) {
    throw new Error("invalid_files_ref");
  }
  return { payloadPath };
}
