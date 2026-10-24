import * as CursorAgentSdk from '@t3tools/provider-cursor/server/CursorAgentSdk'
import * as CursorSdk from '@t3tools/provider-cursor/server/CursorSdk'
import { NoOpProviderEventLoggers, ProviderEventLoggers } from '@t3tools/provider-core/server/ProviderEventLoggers'
import { Layer } from 'effect'
import { Agent, createAgentPlatform, SqliteLocalAgentStore } from './sdk-loader.ts'

/** The disk SDK loaded through Baton's SEA-aware loader instead of the upstream import path. */
const cursorSdkLayer = Layer.succeed(
  CursorSdk.CursorSdk,
  CursorSdk.CursorSdk.of({ Agent, createAgentPlatform, SqliteLocalAgentStore }),
)

export const cursorRunnerLayer = CursorAgentSdk.layer.pipe(
  Layer.provide(cursorSdkLayer),
  Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
)
