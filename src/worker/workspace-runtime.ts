import type { MountedWorkspaceAdapter } from "../workspace/mounted-adapter"

/** Resolves stable Master workspace IDs to directories on the shared CubeFS mount. */
export class WorkspaceRuntime {
  private readonly paths = new Map<string, string>()

  constructor(private readonly adapter: Pick<MountedWorkspaceAdapter, "prepare"> & { start?: () => Promise<void> }) {}

  async start(): Promise<void> {
    if (this.adapter.start) await this.adapter.start()
    else await this.adapter.prepare(".runtime")
  }

  async prepare(workspaceID: string): Promise<string> {
    const existing = this.paths.get(workspaceID)
    if (existing) return existing
    const directory = await this.adapter.prepare(workspaceID)
    this.paths.set(workspaceID, directory)
    return directory
  }

  pathFor(workspaceID: string): string | undefined {
    return this.paths.get(workspaceID)
  }
}
