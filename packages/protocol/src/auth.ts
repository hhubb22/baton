import { Schema } from 'effect'
import { Timestamp, Text } from './common.ts'

export const ChangePasswordInput = Schema.Struct({
  current_password: Text,
  new_password: Text,
})
export type ChangePasswordInput = typeof ChangePasswordInput.Type

export const Employee = Schema.Struct({
  id: Text,
  username: Text,
  display_name: Text,
  auth_source: Text,
  must_change_password: Schema.Boolean,
})
export type Employee = typeof Employee.Type

export const LoginInput = Schema.Struct({
  username: Text,
  password: Text,
})
export type LoginInput = typeof LoginInput.Type

export const SessionResponse = Schema.Struct({
  employee: Employee,
  csrf_token: Schema.String,
  expires_at: Timestamp,
  telemetry: Schema.optionalKey(
    Schema.Struct({
      session_replay: Schema.optionalKey(Schema.Literal('masked')),
    }),
  ),
})
export type SessionResponse = typeof SessionResponse.Type

export const SessionView = Schema.Struct({
  employee: Employee,
  expires_at: Schema.optionalKey(Timestamp),
})
export type SessionView = typeof SessionView.Type
