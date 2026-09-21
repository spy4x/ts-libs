import { createDenoObjectFs } from "./fs.ts"
import { assertDestinationPath, resolveStoragePath } from "./paths.ts"
import type { FileStorage, ObjectFs, PresignOptions, UploadBody } from "./ports.ts"

/** Default base directory, relative to the process working directory. */
export const DEFAULT_LOCAL_BASE_PATH = "./file-storage"

export interface LocalStorageConfig {
  /** Base directory holding `<base>/<bucket>/<object>`. */
  basePath?: string
  /** Filesystem adapter. Defaults to real `Deno` I/O (`--allow-read`/`--allow-write`). */
  fs?: ObjectFs
}

/**
 * Local-filesystem provider for development.
 *
 * Carries no presigned-URL story: a file URL is not an authorisation, so
 * `getUploadURL`/`getDownloadURL` return the object's `file:` URL and the README
 * says plainly that they are dev-only. Bytes are written and read verbatim —
 * this provider never decodes a body to text.
 */
export class LocalStorage implements FileStorage {
  readonly basePath: string
  private readonly fs: ObjectFs

  constructor(config: LocalStorageConfig = {}) {
    this.basePath = config.basePath ?? DEFAULT_LOCAL_BASE_PATH
    this.fs = config.fs ?? createDenoObjectFs()
  }

  async upload(bucket: string, path: string, body: UploadBody): Promise<void> {
    const target = this.fullPath(bucket, path)
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body
    await this.fs.writeObject(target, bytes)
  }

  /**
   * Copy one object to a local file.
   *
   * `toPath` is the caller's destination, not an object key, so it is not
   * constrained to the bucket — a relative path is accepted and resolves
   * against the process working directory, but a `..` segment or a NUL byte
   * is rejected, so a caller-supplied filename cannot redirect the write. See
   * `assertDestinationPath`.
   */
  async download(bucket: string, fromPath: string, toPath: string): Promise<number> {
    const destination = assertDestinationPath(toPath)
    const source = await this.fs.readObject(this.fullPath(bucket, fromPath))
    return await this.fs.writeObject(destination, source)
  }

  async doesExist(bucket: string, path: string): Promise<boolean> {
    return await this.fs.existsObject(this.fullPath(bucket, path))
  }

  /** Dev-only: the object's `file:` URL carrying no authorisation. */
  getDownloadURL(bucket: string, path: string, _options?: PresignOptions): Promise<string> {
    void _options
    return Promise.resolve(this.fileUrl(bucket, path))
  }

  /** Dev-only. `upload()` takes bytes; this URL cannot be used as a direct-upload target. */
  getUploadURL(bucket: string, path: string, _options?: PresignOptions): Promise<string> {
    void _options
    return Promise.resolve(this.fileUrl(bucket, path))
  }

  /** Absolute path of one object, after bucket and key validation. */
  fullPath(bucket: string, path: string): string {
    return resolveStoragePath(this.basePath, bucket, path)
  }

  private fileUrl(bucket: string, path: string): string {
    const absolute = this.fullPath(bucket, path)
    const rooted = absolute.startsWith("/") ? absolute : `${Deno.cwd()}/${absolute}`
    return new URL(rooted, "file:///").href
  }
}
