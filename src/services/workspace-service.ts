import { eq } from "drizzle-orm"
import type { DB } from "../db/client"
import { workspaces } from "../db/schema"
import { newID } from "../util"

export class WorkspaceService {
  constructor(
    private db: DB,
    private now: () => number = Date.now,
  ) {}

  async getOrCreate(input: {
    userId: string
    tenantId: string
    path?: string
  }) {
    const workspacePath = input.path ?? `/workspace/${input.userId}`

    const existing = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.path, workspacePath))
      .get()

    if (existing) return existing

    const now = this.now()
    const workspace = {
      id: newID("ws"),
      user_id: input.userId,
      tenant_id: input.tenantId,
      path: workspacePath,
      created_at: now,
      updated_at: now,
    }

    await this.db.insert(workspaces).values(workspace)
    return workspace
  }
}
