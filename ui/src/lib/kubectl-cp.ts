export type ClusterInfo = { context?: string; kubeconfigPath?: string }
export function kubectlCpReady(info: ClusterInfo): boolean {
  return Boolean(info.context && info.kubeconfigPath)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function kubectlCpCommand(
  fileName: string,
  namespace: string,
  podName: string,
  targetPath: string,
  container: string,
  info: ClusterInfo = {},
): string {
  const baseName = fileName.split(/[\\/]/).pop() || 'file'
  const source = `./${baseName}`
  const target = `${namespace}/${podName}:${targetPath}`
  const flags = [
    '-c', shellQuote(container),
    info.kubeconfigPath ? `--kubeconfig=${shellQuote(info.kubeconfigPath)}` : '',
    info.context ? `--context=${shellQuote(info.context)}` : '',
  ].filter(Boolean)
  return ['kubectl', 'cp', shellQuote(source), shellQuote(target), ...flags].join(' ')
}
