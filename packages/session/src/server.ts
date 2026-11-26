/** Node.js 后端装配 Session、持久化与恢复的入口。 */
export { createPersistedSession, readPersistedSessionHistory } from "./api/use-cases.ts";
export { SessionStore } from "./storage/sqlite.ts";
export type { AcceptTurnResult, SessionHistory, SessionUpdate } from "./storage/sqlite.ts";
export { SessionPersistence } from "./persistence.ts";
export type { SessionAccess, SessionHandle, SessionListMetadata, SessionPersistenceCreateOptions, SessionPersistenceSnapshot } from "./persistence.ts";
export { projectInterruptedSession, recoverInterruptedSession } from "./recovery.ts";
export { Session, SessionStore as MemorySessionStore } from "./session.ts";
export { selectForkCut } from "./fork.ts";
export { snapshotSessionJson } from "./events.ts";
export type { SessionHeader, StagedCommitResult, SurfaceNode } from "./session.ts";
export type { SessionAppendInput } from "./events.ts";
export { fitSurfaceToolPrefix, indexSurfaceToolGroups, isCompleteSurfaceToolRange } from "./surface-tool-pairs.ts";
export { acquireInstanceOwnership, OwnershipConflictError } from "./storage/ownership.ts";
export { SqliteSessionPersistence } from "./storage/sqlite-persistence.ts";
export type { SqliteSessionPersistenceOptions } from "./storage/sqlite-persistence.ts";
