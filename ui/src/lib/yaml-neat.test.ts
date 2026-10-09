import { describe, expect, it } from 'vitest'

import { neatResource } from './yaml-neat'

const pod = (spec: Record<string, unknown> = {}) => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'demo' },
  spec,
})
const tokenName = 'kube-api-access-abc12'
const mount = (name = tokenName) => ({
  name,
  mountPath: '/var/run/secrets/kubernetes.io/serviceaccount',
  readOnly: true,
})
const projected = () => ({
  name: tokenName,
  projected: {
    defaultMode: 420,
    sources: [
      { serviceAccountToken: { expirationSeconds: 3607, path: 'token' } },
      {
        configMap: {
          name: 'kube-root-ca.crt',
          items: [{ key: 'ca.crt', path: 'ca.crt' }],
        },
      },
      {
        downwardAPI: {
          items: [
            {
              path: 'namespace',
              fieldRef: { apiVersion: 'v1', fieldPath: 'metadata.namespace' },
            },
          ],
        },
      },
    ],
  },
})

describe('neatResource', () => {
  it('copies resources and records paths without sensitive values', () => {
    const input = {
      ...pod(),
      metadata: {
        name: 'demo',
        uid: 'secret-uid',
        resourceVersion: '7',
        generation: 2,
        managedFields: [],
        creationTimestamp: null,
        deletionTimestamp: null,
        deletionGracePeriodSeconds: 0,
        selfLink: 'link',
        ownerReferences: [],
        finalizers: ['keep'],
        annotations: {
          'kubectl.kubernetes.io/last-applied-configuration': 'private-body',
          'my.io/x': 'keep',
        },
      },
      status: { phase: 'Running' },
    }
    const snapshot = structuredClone(input)
    const result = neatResource(input)
    expect(input).toEqual(snapshot)
    expect(result.object.metadata).toEqual({
      name: 'demo',
      ownerReferences: [],
      finalizers: ['keep'],
      annotations: { 'my.io/x': 'keep' },
    })
    expect(result.object).not.toHaveProperty('status')
    expect(result.removals).toContainEqual({
      path: '/metadata/annotations/kubectl.kubernetes.io~1last-applied-configuration',
      category: 'metadata',
    })
    expect(JSON.stringify(result.removals)).not.toMatch(
      /private-body|secret-uid/
    )
    expect(neatResource(result.object)).toEqual({
      object: result.object,
      removals: [],
    })
  })
  it('only removes empty metadata containers caused by cleaning and stays idempotent', () => {
    const result = neatResource({
      ...pod(),
      metadata: { creationTimestamp: null },
    })
    expect(result.object).not.toHaveProperty('metadata')
    expect(neatResource(result.object).removals).toEqual([])
    expect(
      neatResource({
        ...pod(),
        metadata: {
          name: 'x',
          annotations: {
            'kubectl.kubernetes.io/last-applied-configuration': 'x',
          },
        },
      }).object.metadata
    ).toEqual({ name: 'x' })
    expect(
      neatResource({ ...pod(), metadata: { annotations: {} } }).object.metadata
    ).toEqual({ annotations: {} })
  })
  it('preserves empty values and unknown CRD business fields', () => {
    const spec = {
      volumes: [{ name: 'scratch', emptyDir: {} }],
      selector: {},
      list: [],
      zero: 0,
      flag: false,
      text: '',
      nodeName: 'node',
      imagePullPolicy: 'Always',
      nullValue: null,
    }
    expect(neatResource(pod(spec)).object.spec).toEqual(spec)
    const input = {
      apiVersion: 'example.io/v1',
      kind: 'Pod',
      metadata: { name: 'x' },
      spec: {
        restartPolicy: 'Always',
        nodeName: 'custom',
        template: { metadata: { uid: 'business' }, status: {} },
      },
    }
    expect(neatResource(input, { removeRuntimeBindings: true }).object).toEqual(
      input
    )
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'secret' },
      type: 'Opaque',
      data: { password: 'c2VjcmV0' },
      stringData: { password: 'sensitive' },
    }
    expect(neatResource(secret).object).toEqual(secret)
  })
  it('removes exact Pod, container and probe defaults only', () => {
    const probe = {
      timeoutSeconds: 1,
      periodSeconds: 10,
      successThreshold: 1,
      failureThreshold: 3,
      httpGet: { path: '/', port: 80, scheme: 'HTTP' },
    }
    const container = {
      name: 'app',
      image: 'app:v1',
      terminationMessagePath: '/dev/termination-log',
      terminationMessagePolicy: 'File',
      ports: [
        { containerPort: 80, protocol: 'TCP' },
        { containerPort: 53, protocol: 'UDP' },
      ],
      livenessProbe: probe,
      readinessProbe: probe,
      startupProbe: probe,
    }
    const result = neatResource(
      pod({
        restartPolicy: 'Always',
        dnsPolicy: 'ClusterFirst',
        schedulerName: 'default-scheduler',
        terminationGracePeriodSeconds: 30,
        enableServiceLinks: true,
        containers: [container],
        initContainers: [container],
        ephemeralContainers: [container],
      })
    )
    const spec = result.object.spec as any
    expect(Object.keys(spec)).toEqual([
      'containers',
      'initContainers',
      'ephemeralContainers',
    ])
    for (const group of ['containers', 'initContainers']) {
      expect(spec[group][0]).not.toHaveProperty('terminationMessagePath')
      expect(spec[group][0].ports).toEqual([
        { containerPort: 80 },
        { containerPort: 53, protocol: 'UDP' },
      ])
      for (const key of ['livenessProbe', 'readinessProbe', 'startupProbe'])
        expect(spec[group][0][key]).toEqual({
          httpGet: { path: '/', port: 80 },
        })
    }
    expect(spec.ephemeralContainers).toEqual([container])
    const custom = {
      restartPolicy: 'Never',
      dnsPolicy: 'None',
      enableServiceLinks: false,
      terminationGracePeriodSeconds: 0,
    }
    expect(neatResource(pod(custom)).object.spec).toEqual(custom)
  })
  it.each([
    'Deployment',
    'ReplicaSet',
    'StatefulSet',
    'DaemonSet',
    'Job',
    'CronJob',
  ])('cleans %s templates but preserves their bindings', (kind) => {
    const template = {
      metadata: {
        creationTimestamp: null,
        labels: { app: 'x' },
        finalizers: ['keep'],
      },
      spec: { restartPolicy: 'Always', nodeName: 'node' },
    }
    const spec =
      kind === 'CronJob'
        ? {
            jobTemplate: {
              metadata: { creationTimestamp: null },
              spec: { template },
            },
          }
        : { template }
    const result = neatResource(
      {
        apiVersion: ['Job', 'CronJob'].includes(kind) ? 'batch/v1' : 'apps/v1',
        kind,
        metadata: { name: 'x' },
        spec,
      },
      { removeRuntimeBindings: true }
    )
    const output = result.object.spec as any
    expect(
      kind === 'CronJob' ? output.jobTemplate.spec.template : output.template
    ).toEqual({
      metadata: { labels: { app: 'x' }, finalizers: ['keep'] },
      spec: { nodeName: 'node' },
    })
  })
  it('preserves Service addressing while removing defaults', () => {
    const result = neatResource(
      {
        ...pod({
          type: 'ClusterIP',
          sessionAffinity: 'None',
          clusterIP: '10.1.0.1',
          ports: [{ port: 80, protocol: 'TCP', nodePort: 32080 }],
        }),
        kind: 'Service',
      },
      { removeRuntimeBindings: true }
    )
    expect(result.object.spec).toEqual({
      clusterIP: '10.1.0.1',
      ports: [{ port: 80, nodePort: 32080 }],
    })
  })
  it('removes verified token volumes and ordinary/init/ephemeral mounts only when opted in', () => {
    const input = {
      ...pod({
        nodeName: 'node',
        volumes: [projected(), { name: 'scratch', emptyDir: {} }],
        containers: [{ volumeMounts: [mount()] }],
        initContainers: [{ volumeMounts: [mount()] }],
        ephemeralContainers: [{ volumeMounts: [mount()] }],
      }),
      metadata: {
        name: 'x',
        ownerReferences: [{ uid: 'owner' }],
        finalizers: ['cleanup'],
      },
    }
    expect(neatResource(input).object).toEqual(input)
    const result = neatResource(input, { removeRuntimeBindings: true })
    expect(result.object.metadata).toEqual({ name: 'x' })
    expect(result.object.spec).toEqual({
      volumes: [{ name: 'scratch', emptyDir: {} }],
      containers: [{ volumeMounts: [] }],
      initContainers: [{ volumeMounts: [] }],
      ephemeralContainers: [{ volumeMounts: [] }],
    })
    expect(
      result.removals.filter((r) => r.category === 'binding')
    ).toHaveLength(7)
  })
  it('supports legacy default-token secrets', () => {
    const name = 'default-token-abc12'
    expect(
      neatResource(
        pod({
          volumes: [{ name, secret: { secretName: name, defaultMode: 420 } }],
          containers: [{ volumeMounts: [mount(name)] }],
        }),
        { removeRuntimeBindings: true }
      ).object.spec
    ).toEqual({ volumes: [], containers: [{ volumeMounts: [] }] })
  })
  it.each([
    'customMount',
    'customSource',
    'customAudience',
    'unknownReference',
    'duplicate',
    'noMount',
  ])('preserves ambiguous volume: %s', (scenario) => {
    const spec: any = {
      volumes: [projected()],
      containers: [{ volumeMounts: [mount()] }],
    }
    if (scenario === 'customMount')
      spec.containers[0].volumeMounts[0].subPath = 'token'
    if (scenario === 'customSource')
      spec.volumes[0].projected.sources.push({ secret: { name: 'custom' } })
    if (scenario === 'customAudience')
      spec.volumes[0].projected.sources[0].serviceAccountToken.audience =
        'custom'
    if (scenario === 'unknownReference')
      spec.containers[0].volumeDevices = [
        { name: tokenName, devicePath: '/dev/x' },
      ]
    if (scenario === 'duplicate') spec.volumes.push(projected())
    if (scenario === 'noMount') spec.containers = []
    expect(
      neatResource(pod(spec), { removeRuntimeBindings: true }).object.spec
    ).toEqual(spec)
  })
  it.each([
    null,
    [],
    'sensitive',
    {},
    { ...pod(), metadata: [] },
    { ...pod(), apiVersion: '' },
    { ...pod(), spec: { value: Infinity } },
  ])('rejects invalid input without exposing values', (input) => {
    expect(() => neatResource(input)).toThrow('Invalid Kubernetes resource')
  })
  it('reports original mount indices when removing several token volumes', () => {
    const names = ['default-token-abc12', 'default-token-def34']
    const input = pod({
      volumes: names.map((name) => ({ name, secret: { secretName: name } })),
      containers: [{ volumeMounts: [mount(names[1]), mount(names[0])] }],
    })
    const result = neatResource(input, { removeRuntimeBindings: true })
    expect(result.object.spec).toEqual({
      volumes: [],
      containers: [{ volumeMounts: [] }],
    })
    expect(result.removals.map((removal) => removal.path)).toEqual(
      expect.arrayContaining([
        '/spec/containers/0/volumeMounts/0',
        '/spec/containers/0/volumeMounts/1',
        '/spec/volumes/0',
        '/spec/volumes/1',
      ])
    )
    expect(
      neatResource(result.object, { removeRuntimeBindings: true }).removals
    ).toEqual([])
  })
  it('rejects cycles', () => {
    const input: any = pod()
    input.spec.self = input
    expect(() => neatResource(input)).toThrow('Invalid Kubernetes resource')
  })
})
