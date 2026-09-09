/** Tenant/user identity + API keys + JWT issuance (design §M1, simplified). */

import { and, eq } from "drizzle-orm"
import type { DB } from "../db/client"
import { apiKeys, tenants, users } from "../db/schema"
import { sha256Hex, signJWT, verifyJWT } from "../auth/jwt"
import type { AuthContext, Role } from "../types"
import { newID } from "../util"

export class IdentityService {
  constructor(
    private db: DB,
    private secret: string,
    private ttlSeconds: number,
    private now: () => number = Date.now,
  ) {}

  /** Upsert tenant + user (idempotent; dev bootstrap). */
  async ensureUser(tenantID: string, userID: string, email?: string): Promise<void> {
    await this.db
      .insert(tenants)
      .values({ id: tenantID, name: tenantID, created_at: this.now() })
      .onConflictDoNothing()
    await this.db
      .insert(users)
      .values({ id: userID, tenant_id: tenantID, email: email ?? null, created_at: this.now() })
      .onConflictDoNothing()
  }

  /** Create a per-user API key; returns the raw key (shown once only). */
  async createApiKey(userID: string, label?: string): Promise<string> {
    const raw = `omk_${newID("", 24)}`
    await this.db.insert(apiKeys).values({
      id: newID("key"),
      user_id: userID,
      key_hash: sha256Hex(raw),
      label: label ?? null,
      revoked: false,
      created_at: this.now(),
    })
    return raw
  }

  async userForApiKey(raw: string): Promise<{ user: string; tenant: string } | undefined> {
    const row = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.key_hash, sha256Hex(raw)), eq(apiKeys.revoked, false)))
      .get()
    if (!row) return undefined
    const user = await this.db.select().from(users).where(eq(users.id, row.user_id)).get()
    return user ? { user: user.id, tenant: user.tenant_id } : undefined
  }

  async issueToken(auth: AuthContext): Promise<string> {
    return signJWT({ sub: auth.sub, tenant: auth.tenant, role: auth.role }, this.secret, this.ttlSeconds)
  }

  async verifyToken(token: string): Promise<AuthContext | null> {
    const payload = await verifyJWT(token, this.secret)
    if (!payload) return null
    const { sub, tenant, role } = payload
    if (typeof sub !== "string" || typeof tenant !== "string") return null
    if (role !== "admin" && role !== "user" && role !== "worker" && role !== "slave") return null
    return { sub, tenant, role }
  }
}
