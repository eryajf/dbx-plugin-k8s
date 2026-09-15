import { DBXInvoke } from './dbx-transport'

export type SessionIdentity = {
  connectionId: string
  namespace: string
  name: string
  container?: string
  node?: string
}
export type SessionFrame = { sessionId: string; kind?: string }

/** Adapter used by Kite-style terminal panels. It deliberately exposes the
 * same lifecycle primitives as Kite while routing through DBX RPC. */
export class KiteSessionTransport {
  constructor(private readonly invoke: DBXInvoke, private readonly connectionId?: string) {}
  private params(identity: Omit<SessionIdentity, 'connectionId'>) { return { ...(this.connectionId ? { connectionId: this.connectionId } : {}), ...identity } }
  openLogs(identity: Omit<SessionIdentity, 'connectionId'> & { follow?: boolean; tailLines?: number }): Promise<SessionFrame> {
    return this.invoke('pod/logs-open', this.params(identity)) as Promise<SessionFrame>
  }
  openExec(identity: Omit<SessionIdentity, 'connectionId'> & { command?: string[] }): Promise<SessionFrame> {
    return this.invoke('pod/exec-open', this.params(identity)) as Promise<SessionFrame>
  }
  read(sessionId: string, limit = 200): Promise<{ data?: string; done?: boolean }> {
    return this.invoke('session/read', { ...(this.connectionId ? { connectionId: this.connectionId } : {}), sessionId, limit }) as Promise<{data?:string;done?:boolean}>
  }
  write(sessionId: string, data: string) { return this.invoke('pod/exec-write', { ...(this.connectionId ? { connectionId: this.connectionId } : {}), sessionId, data }) }
  resize(sessionId: string, cols: number, rows: number) { return this.invoke('pod/exec-resize', { ...(this.connectionId ? { connectionId: this.connectionId } : {}), sessionId, cols, rows }) }
  close(sessionId: string) { return this.invoke('session/close', { ...(this.connectionId ? { connectionId: this.connectionId } : {}), sessionId }) }
  listFiles(identity: Omit<SessionIdentity, 'connectionId'> & { path: string; depth?: number }) { return this.invoke('pod/files-list', this.params(identity)) }
  readFile(identity: Omit<SessionIdentity, 'connectionId'> & { path: string }) { return this.invoke('pod/file-read', this.params(identity)) }
  writeFile(identity: Omit<SessionIdentity, 'connectionId'> & { path: string; content: string }) { return this.invoke('pod/file-write', this.params(identity)) }
  deleteFile(identity: Omit<SessionIdentity, 'connectionId'> & { path: string }) { return this.invoke('pod/file-delete', this.params(identity)) }
  openPortForward(identity: Omit<SessionIdentity, 'connectionId'> & { ports: Array<{localPort:number;remotePort:number}> }) { return this.invoke('port-forward/open', this.params(identity)) }
  closePortForward(sessionId: string) { return this.invoke('port-forward/close', { ...(this.connectionId ? { connectionId: this.connectionId } : {}), sessionId }) }
}

export function createKiteSessionTransport(invoke: DBXInvoke, connectionId: string) { return new KiteSessionTransport(invoke, connectionId) }
