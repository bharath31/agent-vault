export { Nominee, ApprovalDeniedError } from './nominee.js'
export type { NomineeOptions, TokenParams } from './nominee.js'

export { ApprovalEngine } from './approval.js'
export type { ApprovalRequest } from './approval.js'

export { tokens } from './strategies/tokens.js'

export { Memory } from './strategies/memory.js'
export type { MemoryOptions, MemoryStrategy } from './strategies/memory.js'

export { OAuth2 } from './strategies/oauth2.js'
export type { OAuth2Options, OAuth2Connection } from './strategies/oauth2.js'

export type {
  Strategy,
  TokenResolver,
  GetTokenParams,
  TokenResult,
  ApprovalParams,
  ApprovalResult,
  ApprovalDecision,
  AuthzParams,
  ExchangeParams,
} from './strategy.js'

export type { AuditEvent, AuditEventType } from './audit.js'
