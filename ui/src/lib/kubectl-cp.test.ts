import { describe, expect, it } from 'vitest'
import { kubectlCpCommand } from './kubectl-cp'

describe('kubectl cp command', () => {
  it('includes connection context when available and quotes Unicode paths', () => {
    expect(kubectlCpCommand('配置 文件.bin', '生产', 'web pod', '/数据/文件.bin', '主容器', { context: 'prod ctx', kubeconfigPath: '/Users/me/my config' }))
      .toBe("kubectl cp './配置 文件.bin' '生产/web pod:/数据/文件.bin' -c '主容器' --kubeconfig='/Users/me/my config' --context='prod ctx'")
  })

  it('omits unavailable kubeconfig metadata', () => {
    expect(kubectlCpCommand('a.txt', 'default', 'web', '/tmp/a.txt', 'app')).toBe("kubectl cp './a.txt' 'default/web:/tmp/a.txt' -c 'app'")
  })
})
