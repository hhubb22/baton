import { createContext } from 'react'
import type { NodeList } from './types.ts'

export const NodeAvailability = createContext<NodeList | null>(null)
