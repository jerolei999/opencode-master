import { access, mkdir, stat } from "node:fs/promises"
import { join, posix } from "node:path"

export class WorkspaceMountError extends Error {}
export class MountedWorkspacePathError extends WorkspaceMountError {}

export type MountedWorkspaceOptions = {
  /** The directory where CubeFS is mounted on every Worker. */
  root: string
  /** Require the mount root to exist instead of creating a local directory. */
  requireExistingMount?: boolean
  /** Optional deployment-specific readiness probe (mount marker, health API, etc.). */
  isMounted?: () => Promise<boolean>
}

function safeWorkspaceID(workspaceID: string): string {
  if (!workspaceID || workspaceID === "." || workspaceID === ".." || workspaceID.includes("/") || workspaceID.includes("\\") || workspaceID.includes("\0")) {
    throw new MountedWorkspacePathError(`invalid workspace id: ${workspaceID}`)
  }
  const normalized = posix.normalize(workspaceID)
  if (normalized !== workspaceID || normalized.startsWith("..")) throw new MountedWorkspacePathError(`invalid workspace id: ${workspaceID}`)
  return workspaceID
}

export class MountedWorkspaceAdapter {
  private ready = false

  constructor(private readonly options: MountedWorkspaceOptions) {}

  async start(): Promise<void> {
    if (this.ready) return
    const mounted = this.options.isMounted
      ? await this.options.isMounted()
      : await stat(this.options.root).then((entry) => entry.isDirectory()).catch(() => false)
    if (!mounted && (this.options.isMounted || this.options.requireExistingMount)) {
      throw new WorkspaceMountError(`CubeFS mount is unavailable: ${this.options.root}`)
    }
    if (!mounted) {
      await mkdir(this.options.root, { recursive: true })
      await access(this.options.root)
    }
    this.ready = true
  }

  async prepare(workspaceID: string): Promise<string> {
    await this.start()
    const directory = join(this.options.root, safeWorkspaceID(workspaceID))
    await mkdir(directory, { recursive: true })
    return directory
  }

  pathFor(workspaceID: string): string {
    return join(this.options.root, safeWorkspaceID(workspaceID))
  }
}

export { safeWorkspaceID as normalizeMountedWorkspaceID }
