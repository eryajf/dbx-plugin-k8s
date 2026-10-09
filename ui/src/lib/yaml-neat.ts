type JsonObject = Record<string, unknown>
export type NeatRemoval = {
  path: string
  category: 'metadata' | 'status' | 'default' | 'binding'
}
export type NeatResult = { object: JsonObject; removals: NeatRemoval[] }

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const pointer = (path: string[], key: string) => [...path, key]
const own = (object: JsonObject, key: string) =>
  Object.prototype.hasOwnProperty.call(object, key)

// Validate before copying: JSON.stringify alone silently drops unsupported values.
function copyJSON(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || ancestors.has(value))
    throw new Error('Invalid Kubernetes resource')
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new Error('Invalid Kubernetes resource')
  }
  ancestors.add(value)
  const result = Array.isArray(value)
    ? value.map((item) => copyJSON(item, ancestors))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          copyJSON(item, ancestors),
        ])
      )
  ancestors.delete(value)
  return result
}

const onlyKeys = (object: JsonObject, keys: string[]) =>
  Object.keys(object).every((key) => keys.includes(key))
const standardMode = (object: JsonObject) =>
  !own(object, 'defaultMode') || object.defaultMode === 420
function standardTokenVolume(volume: JsonObject): boolean {
  if (typeof volume.name !== 'string') return false
  if (/^default-token-[a-z0-9]{5}$/.test(volume.name)) {
    const secret = volume.secret
    return (
      onlyKeys(volume, ['name', 'secret']) &&
      isObject(secret) &&
      onlyKeys(secret, ['secretName', 'defaultMode']) &&
      secret.secretName === volume.name &&
      standardMode(secret)
    )
  }
  const projected = volume.projected
  if (
    !/^kube-api-access-[a-z0-9]{5}$/.test(volume.name) ||
    !onlyKeys(volume, ['name', 'projected']) ||
    !isObject(projected) ||
    !onlyKeys(projected, ['sources', 'defaultMode']) ||
    !standardMode(projected) ||
    !Array.isArray(projected.sources) ||
    projected.sources.length !== 3
  )
    return false
  let token = 0,
    ca = 0,
    namespace = 0
  for (const source of projected.sources) {
    if (!isObject(source) || Object.keys(source).length !== 1) return false
    const sat = source.serviceAccountToken
    const cm = source.configMap
    const downward = source.downwardAPI
    if (
      isObject(sat) &&
      onlyKeys(sat, ['path', 'expirationSeconds']) &&
      sat.path === 'token' &&
      (!own(sat, 'expirationSeconds') || sat.expirationSeconds === 3607)
    )
      token++
    else if (
      isObject(cm) &&
      onlyKeys(cm, ['name', 'items']) &&
      cm.name === 'kube-root-ca.crt' &&
      Array.isArray(cm.items) &&
      cm.items.length === 1 &&
      isObject(cm.items[0]) &&
      onlyKeys(cm.items[0], ['key', 'path']) &&
      cm.items[0].key === 'ca.crt' &&
      cm.items[0].path === 'ca.crt'
    )
      ca++
    else if (
      isObject(downward) &&
      onlyKeys(downward, ['items']) &&
      Array.isArray(downward.items) &&
      downward.items.length === 1 &&
      isObject(downward.items[0])
    ) {
      const item = downward.items[0]
      const ref = item.fieldRef
      if (
        !onlyKeys(item, ['path', 'fieldRef']) ||
        item.path !== 'namespace' ||
        !isObject(ref) ||
        !onlyKeys(ref, ['apiVersion', 'fieldPath']) ||
        (own(ref, 'apiVersion') && ref.apiVersion !== 'v1') ||
        ref.fieldPath !== 'metadata.namespace'
      )
        return false
      namespace++
    } else return false
  }
  return token === 1 && ca === 1 && namespace === 1
}

/** Produce an export draft without changing the source or contacting Kubernetes. */
export function neatResource(
  input: unknown,
  options: { removeRuntimeBindings?: boolean } = {}
): NeatResult {
  let object: JsonObject
  try {
    const copy = copyJSON(input)
    if (
      !isObject(copy) ||
      typeof copy.apiVersion !== 'string' ||
      !copy.apiVersion.trim() ||
      typeof copy.kind !== 'string' ||
      !copy.kind.trim() ||
      (own(copy, 'metadata') && !isObject(copy.metadata))
    )
      throw new Error()
    object = copy
  } catch {
    throw new Error('Invalid Kubernetes resource')
  }
  const removals: NeatRemoval[] = []
  const record = (path: string[], category: NeatRemoval['category']) =>
    removals.push({
      path:
        '/' +
        path
          .map((part) => part.replace(/~/g, '~0').replace(/\//g, '~1'))
          .join('/'),
      category,
    })
  const remove = (
    target: JsonObject,
    key: string,
    path: string[],
    category: NeatRemoval['category']
  ) => {
    if (!own(target, key)) return false
    delete target[key]
    record(pointer(path, key), category)
    return true
  }
  const defaultValue = (
    target: JsonObject,
    key: string,
    value: unknown,
    path: string[]
  ) => {
    if (target[key] === value) remove(target, key, path, 'default')
  }
  const metadata = (resource: JsonObject, path: string[]) => {
    const meta = resource.metadata
    if (!isObject(meta)) return
    const before = removals.length
    const metaPath = pointer(path, 'metadata')
    for (const key of [
      'uid',
      'resourceVersion',
      'generation',
      'managedFields',
      'creationTimestamp',
      'deletionTimestamp',
      'deletionGracePeriodSeconds',
      'selfLink',
    ]) {
      remove(meta, key, metaPath, 'metadata')
    }
    if (
      isObject(meta.annotations) &&
      remove(
        meta.annotations,
        'kubectl.kubernetes.io/last-applied-configuration',
        pointer(metaPath, 'annotations'),
        'metadata'
      ) &&
      !Object.keys(meta.annotations).length
    ) {
      remove(meta, 'annotations', metaPath, 'metadata')
    }
    if (removals.length > before && !Object.keys(meta).length)
      remove(resource, 'metadata', path, 'metadata')
  }
  remove(object, 'status', [], 'status')
  metadata(object, [])
  if (options.removeRuntimeBindings && isObject(object.metadata)) {
    const before = removals.length
    remove(object.metadata, 'ownerReferences', ['metadata'], 'binding')
    remove(object.metadata, 'finalizers', ['metadata'], 'binding')
    if (removals.length > before && !Object.keys(object.metadata).length)
      remove(object, 'metadata', [], 'binding')
  }
  const spec = object.spec
  if (!isObject(spec)) return { object, removals }
  let pod: JsonObject | undefined
  let podPath: string[] = []
  if (object.apiVersion === 'v1' && object.kind === 'Pod') {
    pod = spec
    podPath = ['spec']
  }
  let template: unknown
  let templatePath: string[] = []
  if (
    (object.apiVersion === 'apps/v1' &&
      ['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet'].includes(
        String(object.kind)
      )) ||
    (object.apiVersion === 'batch/v1' && object.kind === 'Job')
  ) {
    template = spec.template
    templatePath = ['spec', 'template']
  } else if (
    object.apiVersion === 'batch/v1' &&
    object.kind === 'CronJob' &&
    isObject(spec.jobTemplate)
  ) {
    metadata(spec.jobTemplate, ['spec', 'jobTemplate'])
    if (isObject(spec.jobTemplate.spec)) {
      template = spec.jobTemplate.spec.template
      templatePath = ['spec', 'jobTemplate', 'spec', 'template']
    }
  }
  if (isObject(template)) {
    metadata(template, templatePath)
    if (isObject(template.spec)) {
      pod = template.spec
      podPath = pointer(templatePath, 'spec')
    }
  }
  if (pod) {
    for (const [key, value] of Object.entries({
      restartPolicy: 'Always',
      dnsPolicy: 'ClusterFirst',
      schedulerName: 'default-scheduler',
      terminationGracePeriodSeconds: 30,
      enableServiceLinks: true,
    })) {
      defaultValue(pod, key, value, podPath)
    }
    for (const group of ['containers', 'initContainers']) {
      const containers = pod[group]
      if (!Array.isArray(containers)) continue
      containers.forEach((container, index) => {
        if (!isObject(container)) return
        const path = [...podPath, group, String(index)]
        defaultValue(
          container,
          'terminationMessagePath',
          '/dev/termination-log',
          path
        )
        defaultValue(container, 'terminationMessagePolicy', 'File', path)
        if (Array.isArray(container.ports))
          container.ports.forEach((port, i) => {
            if (isObject(port))
              defaultValue(port, 'protocol', 'TCP', [
                ...path,
                'ports',
                String(i),
              ])
          })
        for (const key of ['livenessProbe', 'readinessProbe', 'startupProbe']) {
          const probe = container[key]
          if (!isObject(probe)) continue
          const probePath = pointer(path, key)
          for (const [field, value] of Object.entries({
            timeoutSeconds: 1,
            periodSeconds: 10,
            successThreshold: 1,
            failureThreshold: 3,
          }))
            defaultValue(probe, field, value, probePath)
          if (isObject(probe.httpGet))
            defaultValue(
              probe.httpGet,
              'scheme',
              'HTTP',
              pointer(probePath, 'httpGet')
            )
        }
      })
    }
  }
  if (object.apiVersion === 'v1' && object.kind === 'Service') {
    defaultValue(spec, 'type', 'ClusterIP', ['spec'])
    defaultValue(spec, 'sessionAffinity', 'None', ['spec'])
    if (Array.isArray(spec.ports))
      spec.ports.forEach((port, i) => {
        if (isObject(port))
          defaultValue(port, 'protocol', 'TCP', ['spec', 'ports', String(i)])
      })
  }
  if (
    options.removeRuntimeBindings &&
    object.apiVersion === 'v1' &&
    object.kind === 'Pod'
  ) {
    remove(spec, 'nodeName', ['spec'], 'binding')
    if (Array.isArray(spec.volumes)) {
      const pending = new Map<unknown[], number[]>()
      const queue = (array: unknown[], index: number) =>
        pending.set(array, [...(pending.get(array) ?? []), index])
      // Process backwards so recorded indices still refer to the source document.
      for (let i = spec.volumes.length - 1; i >= 0; i--) {
        const volume = spec.volumes[i]
        if (
          !isObject(volume) ||
          !standardTokenVolume(volume) ||
          spec.volumes.filter((v) => isObject(v) && v.name === volume.name)
            .length !== 1
        )
          continue
        const mounts: { array: unknown[]; index: number; path: string[] }[] = []
        let safe = true
        const remaining = copyJSON(spec) as JsonObject
        // Other volumes or arbitrary fields referencing this volume make removal unsafe.
        ;(remaining.volumes as unknown[]).splice(i, 1)
        for (const group of [
          'containers',
          'initContainers',
          'ephemeralContainers',
        ]) {
          const containers = spec[group]
          if (!Array.isArray(containers)) continue
          containers.forEach((container, ci) => {
            if (!isObject(container) || !Array.isArray(container.volumeMounts))
              return
            for (let mi = container.volumeMounts.length - 1; mi >= 0; mi--) {
              const mount = container.volumeMounts[mi]
              if (!isObject(mount) || mount.name !== volume.name) continue
              if (
                !onlyKeys(mount, ['name', 'mountPath', 'readOnly']) ||
                mount.mountPath !==
                  '/var/run/secrets/kubernetes.io/serviceaccount' ||
                mount.readOnly !== true
              ) {
                safe = false
                continue
              }
              mounts.push({
                array: container.volumeMounts,
                index: mi,
                path: ['spec', group, String(ci), 'volumeMounts', String(mi)],
              })
              const copiedContainer = (remaining[group] as JsonObject[])[ci]
              ;(copiedContainer.volumeMounts as unknown[]).splice(mi, 1)
            }
          })
        }
        const referencesName = (value: unknown): boolean =>
          value === volume.name ||
          (Array.isArray(value)
            ? value.some(referencesName)
            : isObject(value) && Object.values(value).some(referencesName))
        if (!safe || !mounts.length || referencesName(remaining)) continue
        for (const mount of mounts) {
          queue(mount.array, mount.index)
          record(mount.path, 'binding')
        }
        queue(spec.volumes, i)
        record(['spec', 'volumes', String(i)], 'binding')
      }
      for (const [array, indices] of pending) {
        for (const index of indices.sort((a, b) => b - a))
          array.splice(index, 1)
      }
    }
  }
  return { object, removals }
}
