/** Shared domain types (mirror of design §1 / §3). */

export type SlaveStatus = "ok" | "draining" | "unhealthy"
export type WorkerStatus = SlaveStatus
export type SlaveLoad = { cpuPct:number; memPct:number; activeDrains:number; pendingSteer:number; pendingQueue:number; toolProcesses:number }
export type WorkerLoad = SlaveLoad
export type SlaveCapacity = { maxDrains?:number; maxSessions?:number }
export type WorkerCapacity = SlaveCapacity
export type SlaveView = { id:string; address:string; region?:string; version?:string; configVersion?:string; status:SlaveStatus; load:SlaveLoad; capacity:SlaveCapacity; lastHeartbeatAt?:number; firstSeenAt:number }
export type WorkerView = { id:string; address:string; region?:string; version?:string; configVersion?:string; status:WorkerStatus; load:WorkerLoad; capacity:WorkerCapacity; lastHeartbeatAt?:number; firstSeenAt:number }
export type SessionStatus = "pending" | "assigned" | "running" | "waiting_input" | "resuming" | "recovering" | "ended"
export type TurnStatus = "pending" | "leased" | "completed" | "failed"
export type InteractionStatus = "waiting" | "resolved" | "cancelled" | "expired"
export type InteractionType = "question" | "approval" | "input"
export type ExecutionStatus = "running" | "waiting_input" | "resumed" | "completed" | "failed"
export type SessionRow = { id:string; userId:string; tenantId:string; title:string; workspaceId?:string; directory?:string; status:SessionStatus; ownerWorkerId?:string; ownerSlaveId?:string; leaseEpoch:number; createdAt:number; updatedAt:number; endedAt?:number }
export type TurnRow = { id:string; sessionId:string; userId:string; content:string; clientKey:string; status:TurnStatus; leaseEpoch:number; assignedWorkerId:string; errorMessage?:string; createdAt:number; updatedAt:number; completedAt?:number }
export type HistoryItem = { id?:string; role:"user"|"assistant"|"tool"; content:string; name?:string; reasoning?:string }
export type MasterEvent = { id:string; sessionID:string; tenantID:string; turnID:string; workerID:string; leaseEpoch:number; seq:string; sourceID:string; type:string; data:Record<string,unknown>; at:number }
export type WorkerEventEnvelope = { sessionID:string; turnID:string; leaseEpoch:number; sourceID:string; type:string; data:Record<string,unknown> }
export type LeaseStatus = "active" | "recovering" | "released"
export type LeaseRow = { sessionId:string; slaveId:string; userId:string; ticket:string; expiresAt:number; status:LeaseStatus; createdAt:number; updatedAt:number }
export type Role = "admin" | "user" | "worker" | "slave"
export type AuthContext = { sub:string; tenant:string; role:Role }
export type Delivery = "steer" | "queue"
export type PromptRow = { id:string; sessionId:string; userId:string; content:string; delivery:Delivery; status:"pending"|"delivered"; seq:number; createdAt:number }
export type EventRow = { id:string; tenantId:string; sessionId:string; seq:number; type:string; data:Record<string,unknown>; receivedAt:number }
export type Instruction = { type:"none" } | { type:"drain" } | { type:"warpSession"; sessionID:string } | { type:"resumeSession"; commandID?:string; sessionID:string; interactionID:string; answer:Record<string,unknown> } | { type:"shutdown" }
