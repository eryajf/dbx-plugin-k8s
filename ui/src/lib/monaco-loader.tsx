import { lazy } from 'react'

import { configureMonaco } from './monaco-runtime'

export const MonacoEditor = lazy(async () => {
  const module = await configureMonaco()
  return { default: module.default }
})

export const MonacoDiffEditor = lazy(async () => {
  const module = await configureMonaco()
  return { default: module.DiffEditor }
})
