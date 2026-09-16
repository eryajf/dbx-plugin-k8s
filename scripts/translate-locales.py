#!/usr/bin/env python3
"""Maintenance-only machine draft of public UI strings; never runs in builds.

Sends only en.json/zh-CN.json static text to Google Translate. Caches drafts in
ignored tmp/i18n. Proofread changes and run check-i18n before shipping.
"""
import argparse
import concurrent.futures
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / 'ui/src/i18n/locales'
CACHE = ROOT / 'tmp/i18n'
TERMS = '''Kubernetes K8s DBX Kite Pod Deployment StatefulSet DaemonSet ReplicaSet ReplicationController Job CronJob Service Ingress IngressClass ConfigMap Secret Namespace Node PersistentVolume PersistentVolumeClaim StorageClass VolumeSnapshot VolumeSnapshotClass VolumeSnapshotContent ResourceQuota LimitRange ServiceAccount Role RoleBinding ClusterRole ClusterRoleBinding CustomResourceDefinition CRD HPA PVC PV Gateway GatewayClass HTTPRoute GRPCRoute TCPRoute TLSRoute UDPRoute NetworkPolicy EndpointSlice Endpoints PodDisruptionBudget HorizontalPodAutoscaler API YAML JSON XML CPU GPU IP UID GID CIDR DNS TCP UDP HTTP HTTPS TLS SSL SSH RBAC OIDC OAuth LDAP JWT CSI CNI CORS XTerm Monaco Prometheus Grafana OpenAI Anthropic Docker kubectl kubeconfig Kubeconfig kubelet kube-proxy CrashLoopBackOff ImagePullBackOff ErrImagePull ContainerCreating OOMKilled ReadWriteOnce ReadOnlyMany ReadWriteMany ReadWriteOncePod WaitForFirstConsumer RollingUpdate OnDelete ClusterIP NodePort LoadBalancer ExternalName emptyDir hostPath configMap secretKeyRef configMapKeyRef fieldRef resourceFieldRef mountPath subPath imagePullPolicy readOnlyRootFilesystem runAsNonRoot runAsUser runAsGroup fsGroup allowPrivilegeEscalation privileged serviceAccountName nodeSelector tolerations affinity ingressClassName storageClassName volumeMode accessModes resourceVersion apiVersion GitHub CNB AWS EBS EFS EKS NFS S3 VPA APIKey baseURL'''.split()
TERMS += 'pod pods deployments statefulsets daemonsets replicasets cronjobs configmaps secrets kubeconfig kubectl 100m 500m 128Mi 1Gi 512M 512Mi 2Gi 1G'.split()
TECHNICAL = set(TERMS) | {'N/A', 'Pro', 'Sidecar', 'Pod IP', 'Pod CIDR', 'Ki', 'Mi', 'Gi', 'Ti', 'Pi', 'Ei', 'k', 'M', 'G', 'T', 'P', 'E', 'PVCs', 'PVs', 'Pods', 'AWS EBS CSI', 'AWS EKS Auto Mode EBS', 'AWS EFS CSI'}
TOKEN = re.compile(r'%[sdif]|\{\{.*?\}\}|\$\{.*?\}|`[^`]*`|</?[A-Za-z][^>]*>|https?://[^\s<>]+|\b(?:' + '|'.join(re.escape(x) for x in sorted(TERMS,key=len,reverse=True)) + r')\b')


def protect(text):
    tokens = []
    def replace(match):
        tokens.append(match.group())
        return f'ZXQKEEP{len(tokens)-1}QXZ'
    return TOKEN.sub(replace,text), tokens


def restore(text,tokens):
    for i, token in enumerate(tokens):
        pattern = re.compile(r'ZXQ\s*KEEP\s*'+str(i)+r'\s*QXZ',re.I)
        if len(pattern.findall(text)) != 1:
            raise ValueError('Protected token missing or repeated: '+text)
        text = pattern.sub(lambda _:token,text)
    if 'ZXQ' in text: raise ValueError('Unresolved token: '+text)
    return text


def flatten(obj):
    for value in obj.values():
        if isinstance(value,dict): yield from flatten(value)
        else: yield value


def translate_batch(strings, lang, source):
    protected = [protect(s) for s in strings]
    params = [('client','dict-chrome-ex'),('sl',source),('tl',lang)] + [('q',s) for s,_ in protected]
    url = 'https://translate.google.com/translate_a/t?' + urllib.parse.urlencode(params)
    for attempt in range(3):
        try:
            request = urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'})
            with urllib.request.urlopen(request,timeout=45) as response:
                data = json.load(response)
            if not isinstance(data,list) or len(data)!=len(strings):
                raise ValueError('Unexpected translation response shape')
            return {s:restore(v if isinstance(v,str) else v[0],tokens) for s,v,(_,tokens) in zip(strings,data,protected)}
        except Exception:
            if attempt==2: raise
            time.sleep(2*(attempt+1))


def translate_locale(locale):
    source='zh-CN' if locale=='zh-TW' else 'en'
    src=json.loads((DIR/(source+'.json')).read_text())
    cache_file=CACHE/(locale+'.json')
    cache=json.loads(cache_file.read_text()) if cache_file.exists() else {}
    # Increment the version when the protected-token grammar changes.
    version_file=CACHE/(locale+'.version')
    if not version_file.exists() or version_file.read_text() != '2':
        cache={s:v for s,v in cache.items() if not re.search(r'\b(?:pod|pods|deployments|statefulsets|daemonsets|replicasets|cronjobs|configmaps|secrets|100m|500m|128Mi|1Gi|512M|512Mi|2Gi|1G)\b',s)}
        version_file.write_text('2')
    existing=json.loads((DIR/(locale+'.json')).read_text()) if args.missing_only else {}
    def missing_values(source, target):
        for k,v in source.items():
            if isinstance(v,dict): yield from missing_values(v,target.get(k,{}))
            elif k not in target: yield v
    unique=list(dict.fromkeys(missing_values(src,existing)))
    for s in unique:
        if s in TECHNICAL or not re.search(r'[A-Za-z\u3400-\u9fff]',s): cache[s]=s
    missing=[s for s in unique if s not in cache]
    batches=[];batch=[];size=0
    for s in missing:
        length=len(urllib.parse.quote(protect(s)[0]))+3
        if batch and (size+length>5500 or len(batch)>=30):
            batches.append(batch);batch=[];size=0
        batch.append(s);size+=length
    if batch:batches.append(batch)
    print(f'{locale}: {len(missing)} unique strings in {len(batches)} batches',flush=True)
    for i, batch in enumerate(batches):
        try:
            translated=translate_batch(batch,locale,source)
        except ValueError:
            translated={}
            for s in batch:
                translated.update(translate_batch([s],locale,source))
        cache.update(translated)
        cache_file.write_text(json.dumps(cache,ensure_ascii=False,indent=2)+'\n')
        if i%5==0 or i==len(batches)-1:print(f'{locale}: {i+1}/{len(batches)} batches',flush=True)
        time.sleep(.3)
    def fill(obj,target): return {k:fill(v,target.get(k,{})) if isinstance(v,dict) else target.get(k,cache.get(v)) for k,v in obj.items()}
    (DIR/(locale+'.json')).write_text(json.dumps(fill(src,existing),ensure_ascii=False,indent=2)+'\n')
    print(f'{locale}: written',flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('locales',nargs='+',choices=['az','es','it','ja','ko','pt-BR','tr','zh-TW'])
    parser.add_argument('--missing-only',action='store_true',help='Preserve reviewed existing values; translate only missing keys')
    args=parser.parse_args()
    CACHE.mkdir(parents=True,exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        for result in pool.map(translate_locale,args.locales): pass
