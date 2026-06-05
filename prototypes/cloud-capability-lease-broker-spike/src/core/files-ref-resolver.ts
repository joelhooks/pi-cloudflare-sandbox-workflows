import type { ResolvedFilesPayload } from "./schemas.ts";

export interface FilesRefResolver {
  resolve(filesRef: string): Promise<ResolvedFilesPayload>;
}
