import { constants } from "node:fs";
import { open, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError, byteHash } from "./security.js";
import type { Artifact } from "./state.js";

export class ArtifactStore {
  constructor(readonly root: string) {}
  async save(
    jobId: string,
    name: string,
    mediaType: string,
    bytes: Buffer,
    version: number,
    workspaceRevision: number,
  ): Promise<Artifact> {
    if (
      !name ||
      name.includes("/") ||
      name.includes("\\") ||
      /[\x00-\x1f\x7f]/.test(name) ||
      name.length > 150
    )
      throw new AppError(400, "成果物名が不正です");
    if (
      !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(mediaType) ||
      mediaType.length > 100
    )
      throw new AppError(400, "成果物の種類が不正です");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const id = randomUUID(),
      temporary = join(this.root, `.pending-${id}`),
      target = join(this.root, id);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
    const directory = await open(
      this.root,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return {
      id,
      jobId,
      name,
      mediaType,
      size: bytes.length,
      sha256: byteHash(bytes),
      version,
      workspaceRevision,
      createdAt: new Date().toISOString(),
    };
  }
  async read(
    artifact: Pick<Artifact, "id" | "sha256" | "size">,
  ): Promise<Buffer> {
    if (!/^[a-f0-9-]{36}$/.test(artifact.id))
      throw new AppError(404, "成果物がありません");
    const file = await open(
      join(this.root, artifact.id),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077 ||
        info.size !== artifact.size
      )
        throw new AppError(503, "成果物の整合性を確認できません");
      const bytes = Buffer.alloc(artifact.size);
      let offset = 0;
      while (offset < bytes.length) {
        const part = await file.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!part.bytesRead) break;
        offset += part.bytesRead;
      }
      if (offset !== bytes.length || byteHash(bytes) !== artifact.sha256)
        throw new AppError(503, "成果物のハッシュが一致しません");
      return bytes;
    } finally {
      await file.close();
    }
  }
}
