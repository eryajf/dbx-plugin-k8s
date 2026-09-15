type ReactMonacoModule = typeof import('@monaco-editor/react')
type MonacoApiModule =
  typeof import('monaco-editor/esm/vs/editor/editor.api.js')
type NetworkInformationLike = {
  effectiveType?: string
  saveData?: boolean
}

let monacoSetupPromise: Promise<ReactMonacoModule> | null = null

export function configureMonaco(): Promise<ReactMonacoModule> {
  if (!monacoSetupPromise) {
    monacoSetupPromise = Promise.all([
      import('@monaco-editor/react'),
      import('monaco-editor/esm/vs/editor/editor.api.js'),
      import('monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js'),
      import('monaco-editor/esm/vs/editor/editor.worker?worker&inline'),
    ])
      .then(([reactMonacoModule, monacoModule, , workerModule]) => {
        const MonacoWorker = workerModule.default
        const globalScope = globalThis as typeof globalThis & {
          MonacoEnvironment?: {
            getWorker: () => Worker
          }
        }
        const monacoApi = monacoModule as MonacoApiModule

        globalScope.MonacoEnvironment = {
          getWorker() {
            return new MonacoWorker()
          },
        }

        reactMonacoModule.loader.config({ monaco: monacoApi })
        return reactMonacoModule
      })
      .catch((error) => {
        monacoSetupPromise = null
        throw error
      })
  }

  return monacoSetupPromise
}

export function prefetchMonaco() {
  if (typeof window === 'undefined') {
    return
  }

  const connection = (
    navigator as Navigator & {
      connection?: NetworkInformationLike
    }
  ).connection

  if (connection?.saveData) {
    return
  }

  if (
    connection?.effectiveType === 'slow-2g' ||
    connection?.effectiveType === '2g'
  ) {
    return
  }

  const warmMonaco = () => {
    void configureMonaco()
  }

  const requestIdleCallback = (
    globalThis as typeof globalThis & {
      requestIdleCallback?: (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions
      ) => number
    }
  ).requestIdleCallback

  if (requestIdleCallback) {
    requestIdleCallback(
      () => {
        warmMonaco()
      },
      { timeout: 3000 }
    )
    return
  }

  setTimeout(warmMonaco, 1500)
}
