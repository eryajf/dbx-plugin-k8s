import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const technicalConstants = new Set([
  'CPU',
  'GPU',
  'RAM',
  'IP',
  'TCP',
  'UDP',
  'HTTP',
  'HTTPS',
  'YAML',
  'JSON',
  'API',
  'URL',
  'UID',
  'PVC',
  'PV',
  'HPA',
  'CRD',
  'RBAC',
  'TLS',
  'SSH',
  'kubectl',
  'Kubernetes',
  'Pod',
  'Pods',
  'Deployment',
  'Deployments',
  'StatefulSet',
  'DaemonSet',
  'Service',
  'Ingress',
  'ConfigMap',
  'Secret',
  'CronJob',
  'Job',
  'Node',
  'Namespace',
  'ReplicaSet',
  'StorageClass',
  'PersistentVolume',
  'PersistentVolumeClaim',
  'ClusterRole',
  'ClusterRoleBinding',
  'RoleBinding',
  'ServiceAccount',
  'ResourceQuota',
  'LimitRange',
  'NetworkPolicy',
  'Gateway',
  'HTTPRoute',
  'GRPCRoute',
  'TCPRoute',
  'TLSRoute',
  'UDPRoute',
  'EndpointSlice',
  'Endpoints',
  'VolumeAttachment',
  'CSIDriver',
  'CSINode',
  'PriorityClass',
  'RuntimeClass',
  'PodDisruptionBudget',
  'ValidatingWebhookConfiguration',
  'MutatingWebhookConfiguration',
  'CustomResourceDefinition',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '10',
  '20',
  '50',
  '100',
  '-',
  '—',
  '…',
  '...',
  '/',
  ':',
])
// Reviewed technical literals are intentionally shared across languages.
for (const value of [
  'N/A',
  'PVCs',
  'PVs',
  'CRDs',
  'StatefulSets',
  'DaemonSets',
  'ReplicaSets',
  'CronJobs',
  'ConfigMaps',
  'PersistentVolumeClaims',
  'Gateways',
  'Namespaces',
  'Role',
  'LDAP',
  'Prometheus',
  'Kubeconfig',
  'Kubectl',
  'Kite',
  'Claude',
  'Pro',
  'OpenAI',
  'Anthropic',
  'GitHub',
  'CNB',
  'CrashLoopBackOff',
  'ContainerCreating',
  'ImagePullBackOff',
  'Sidecar',
  'subPath',
  'GID',
  'OS',
  'TTY / Stdin',
  'Pod IP',
  'Pod CIDR',
  'Prometheus URL',
  'AWS EBS CSI',
  'AWS EKS Auto Mode EBS',
  'AWS EFS CSI',
  'Tencent Cloud TKE CBS',
  'ReadWriteOnce',
  'ReadOnlyMany',
  'ReadWriteMany',
  'Cluster IP',
  'Service Port',
  'Node Port',
  'Ki',
  'Mi',
  'Gi',
  'Ti',
  'Pi',
  'Ei',
  'k',
  'M',
  'G',
  'T',
  'P',
  'E',
  'https://prometheus.example.com',
])
  technicalConstants.add(value)

// These are valid native words/cognates, not blanket exceptions for whole sections.
const nativeIdentical = {
  es: new Set([
    'Error',
    'No',
    'Roles',
    'Terminal',
    '{{name}} · Terminal',
    'Total',
    'General',
    'Plan',
    'Monitor',
    'Selector',
    'bytes',
    'Error: {{message}}',
  ]),
  it: new Set([
    'Namespace *',
    'No',
    'Backend',
    'Password',
    'Desktop',
    'Font',
    'Volume',
    'Volume {{index}}',
    'Rollback',
    'Patch {{target}}',
    'Patch {{target}}: {{patch}}',
  ]),
  'pt-BR': new Set([
    'Namespace *',
    'Status',
    'Terminal',
    '{{name}} · Terminal',
    'Total',
    'Volume',
    'Volumes',
    'Volume {{index}}',
    'Monitor',
    'bytes',
    'via {{provider}}',
  ]),
  az: new Set([
    'Minimal',
    'Terminal',
    '{{name}} · Terminal',
    'Backend',
    'Audit',
    'Plan',
    'Model',
    'Monitor',
    'Operator',
    'NFS Server',
  ]),
  tr: new Set(['Terminal', '{{name}} · Terminal']),
}
const simplifiedOnly =
  /[这语简转发复软节网点开关闭载设选删创储显览签态权证务数库组终连请错误败确认执统级计时钟间队标记说读写获传输镜检测启无内为从与将仅让则应还进远过达适递迁换频类实备现见观视规览让试详调许访识译询课语该诸读谁谈谢谱购贴贮费账资赞赠输轻轮较辅辈边运还这进远违连迟迹适选逊递逻邮释长门闩闪闭问闯闲间闹阁阅阀队阳阴阵阶际陆陈险随隐难页顶项顺须顾顿预领颈频题额颜风飞饱馆马驱验鸟鸡麦黄齐齿龙]/u
const literalExamples = (s) => multiset(s, /\b\d+(?:Mi|Gi|Ti|Ki|M|G|m)\b/g)
const multiset = (s, re) =>
  [...s.matchAll(re)]
    .map((m) => m[0])
    .sort()
    .join('\n')
const placeholders = (s) => multiset(s, /{{\s*[^}]+}}|\$\{[^}]+\}|%[sdif]/g)
const markup = (s) =>
  multiset(s, /<\/?[A-Za-z][A-Za-z0-9]*(?:\s[^<>]*?)?\s*\/?>|<\/?\d+\s*>/g)
const invalidUnicode = (s) =>
  /\uFFFD|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    s
  )
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)

export function validateLocale(
  base,
  target,
  { locale = 'target', source = false, exemptions = technicalConstants } = {}
) {
  const errors = []
  let total = 0,
    identical = 0,
    untranslated = 0
  const visit = (a, b, p) => {
    if (object(a)) {
      if (!object(b)) {
        errors.push(`${p}: expected object`)
        return
      }
      for (const k of Object.keys(a)) {
        if (!Object.hasOwn(b, k))
          errors.push(`${p ? p + '.' : ''}${k}: missing key`)
        else visit(a[k], b[k], p ? `${p}.${k}` : k)
      }
      for (const k of Object.keys(b))
        if (!Object.hasOwn(a, k))
          errors.push(`${p ? p + '.' : ''}${k}: extra key`)
      return
    }
    total++
    if (typeof a !== 'string' || typeof b !== 'string') {
      errors.push(`${p}: expected string`)
      return
    }
    if (invalidUnicode(b)) errors.push(`${p}: invalid Unicode`)
    if (locale === 'zh-TW' && simplifiedOnly.test(b))
      errors.push(`${p}: Simplified-only character in Traditional resource`)
    if (/^resourceKind\.(?!resource$)/.test(p) && a !== b)
      errors.push(`${p}: Kubernetes Kind must remain unchanged`)
    if (literalExamples(a) !== literalExamples(b))
      errors.push(`${p}: resource quantity example mismatch`)
    if (placeholders(a) !== placeholders(b))
      errors.push(`${p}: placeholder mismatch`)
    if (markup(a) !== markup(b)) errors.push(`${p}: markup mismatch`)
    if ((a.match(/`/g) || []).length !== (b.match(/`/g) || []).length)
      errors.push(`${p}: backtick mismatch`)
    if (a === b) {
      identical++
      if (
        !source &&
        /[A-Za-z]/.test(a) &&
        !exemptions.has(a) &&
        !nativeIdentical[locale]?.has(a)
      ) {
        untranslated++
        errors.push(`${p}: untranslated English value`)
      }
    }
  }
  visit(base, target, '')
  return { locale, total, identical, untranslated, errors }
}

export function checkDirectory(
  dir,
  {
    locales = [
      'az',
      'en',
      'es',
      'it',
      'ja',
      'ko',
      'pt-BR',
      'tr',
      'zh-CN',
      'zh-TW',
    ],
  } = {}
) {
  const results = []
  let base
  try {
    base = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'))
  } catch (e) {
    return {
      ok: false,
      results: [{ locale: 'en', errors: [`invalid JSON: ${e.message}`] }],
    }
  }
  for (const locale of locales) {
    try {
      const target = JSON.parse(
        fs.readFileSync(path.join(dir, `${locale}.json`), 'utf8')
      )
      results.push(
        validateLocale(base, target, { locale, source: locale === 'en' })
      )
    } catch (e) {
      results.push({ locale, errors: [`invalid JSON: ${e.message}`] })
    }
  }
  return { ok: results.every((r) => !r.errors.length), results }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const dir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../ui/src/i18n/locales'
  )
  const report = process.argv.includes('--report')
  const result = checkDirectory(dir)
  for (const r of result.results) {
    if (report)
      console.log(
        `${r.locale}: ${r.identical ?? 0}/${r.total ?? 0} identical; ${r.untranslated ?? 0} untranslated; ${r.errors.length} issues`
      )
    else for (const e of r.errors) console.error(`${r.locale}: ${e}`)
  }
  if (!report && !result.ok) process.exitCode = 1
  else if (!report) console.log('i18n check passed')
}
