export type WorkspaceObject = { path: string; digest: string; size: number; contentType?: string }

export interface WorkspaceStore {
  put(workspaceID: string, relativePath: string, data: Uint8Array, contentType?: string): Promise<WorkspaceObject>
  get(workspaceID: string, relativePath: string): Promise<Uint8Array>
  list(workspaceID: string): Promise<WorkspaceObject[]>
  delete(workspaceID: string, relativePath: string): Promise<void>
}

export type WorkspaceVersion = { workspaceID: string; version: string; parentVersion?: string; objects: WorkspaceObject[]; createdAt: number }

export interface WorkspaceManifestRepository {
  head(workspaceID: string): Promise<WorkspaceVersion | undefined>
  read(workspaceID: string, version: string): Promise<WorkspaceVersion | undefined>
  commit(workspaceID: string, parentVersion: string | undefined, objects: WorkspaceObject[]): Promise<WorkspaceVersion>
}
