import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";

export type DBXPageContext = {
  route: string;
  resource?: string;
  namespace?: string;
  name?: string;
};

export type DBXAIRecommendation = {
  id: string;
  label: string;
  prompt: string;
  order?: number;
};

type DBXAIRecommendationUpdate = {
  context: Record<string, unknown>;
  items: DBXAIRecommendation[];
};

type DBXBridge = {
  ready: Promise<void>;
  context?: { connectionId?: string };
  onContext?: (listener: () => void) => () => void;
  capabilities?: { ai?: boolean; aiRecommendations?: boolean };
  invoke?: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  ai?: {
    setRecommendations?: (update: DBXAIRecommendationUpdate) => Promise<void>;
    clearRecommendations?: () => Promise<void>;
    openConversation?: (request: {
      title: string;
      prompt: string;
      context: Record<string, unknown>;
      send?: boolean;
      mode?: "ask" | "agent";
    }) => Promise<void>;
  };
};

const bridge = () =>
  (globalThis as typeof globalThis & { dbxPlugin?: DBXBridge }).dbxPlugin;

export function dbxAIPage(pathname: string): DBXPageContext {
  const route = pathname || "/";
  const parts = route.split("/").filter(Boolean).map(decodeURIComponent);
  if (
    parts.length === 0 ||
    parts[0] === "dashboard" ||
    parts[0] === "settings" ||
    parts[0] === "favorites" ||
    parts[0] === "networking"
  ) {
    return { route };
  }
  if (parts[0] === "crds") {
    if (parts.length >= 4) {
      return {
        route,
        resource: parts[1],
        namespace: parts[2],
        name: parts[3],
      };
    }
    if (parts.length === 3)
      return { route, resource: parts[1], name: parts[2] };
    return {
      route,
      resource: parts[1] || "customresourcedefinitions",
    };
  }
  const page: DBXPageContext = { route, resource: parts[0] };
  if (parts.length >= 3) {
    page.namespace = parts[1];
    page.name = parts[2];
  } else if (parts.length === 2) {
    page.name = parts[1];
  }
  return page;
}

function recommendationContext(page: DBXPageContext, connectionId?: string) {
  const resourceKinds: Record<string, string> = {
    pods: "pod",
    deployments: "deployment",
    nodes: "node",
    services: "service",
    namespaces: "namespace",
    jobs: "job",
    cronjobs: "cronjob",
    statefulsets: "statefulset",
    daemonsets: "daemonset",
    configmaps: "configmap",
    secrets: "secret",
    persistentvolumeclaims: "persistent volume claim",
    persistentvolumes: "persistent volume",
    storageclasses: "storage class",
    ingresses: "ingress",
    gateways: "gateway",
    httproutes: "HTTP route",
    horizontalpodautoscalers: "horizontal pod autoscaler",
    networkpolicies: "network policy",
    events: "event",
  };
  return {
    page,
    route: page.route,
    connectionId,
    resource: {
      kind: resourceKinds[page.resource || ""] || page.resource || "cluster",
      name: page.name || "cluster",
      namespace: page.namespace || "all namespaces",
    },
  };
}

export function useDBXAIAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const current = bridge();
    if (!current) return;
    let alive = true;
    current.ready
      .then(() => {
        if (alive) {
          setAvailable(Boolean(current.capabilities?.ai && current.ai?.openConversation));
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return available;
}

export async function openDBXAIConversation(
  page: DBXPageContext,
  title: string,
  prompt: string,
) {
  const current = bridge();
  if (!current) throw new Error("DBX host bridge is unavailable");
  await current.ready;
  if (!current.capabilities?.ai || !current.ai?.openConversation) {
    throw new Error("DBX AI conversations are unavailable");
  }
  const connectionId = current.context?.connectionId;
  let snapshot: unknown;
  if (current.invoke && connectionId) {
    try {
      snapshot = await current.invoke("ai/snapshot", { connectionId, page });
    } catch {
      // Route context still lets the host open a useful conversation.
    }
  }
  const context = {
    ...(snapshot && typeof snapshot === "object"
      ? (snapshot as Record<string, unknown>)
      : {}),
    ...recommendationContext(page, connectionId),
  };
  await current.ai.openConversation({
    title,
    prompt,
    context,
    send: true,
    mode: "agent",
  });
}

/** Reuse Kite's resource-specific prompt catalog, capped by the DBX protocol. */
export function dbxAIRecommendations(
  page: DBXPageContext,
): DBXAIRecommendation[] {
  const prompts: Record<string, string[]> = {
    overview: [
      "aiChat.suggestedPrompts.overview.clusterHealth",
      "aiChat.suggestedPrompts.overview.errorPods",
      "aiChat.suggestedPrompts.overview.namespaceSummary",
      "aiChat.suggestedPrompts.overview.topRisks",
      "aiChat.suggestedPrompts.overview.riskTheme",
      "aiChat.suggestedPrompts.overview.investigationOrder",
    ],
    "pods-list": [
      "aiChat.suggestedPrompts.podsList.anomalies",
      "aiChat.suggestedPrompts.podsList.restarts",
      "aiChat.suggestedPrompts.podsList.probeIssues",
      "aiChat.suggestedPrompts.podsList.oomRisk",
      "aiChat.suggestedPrompts.podsList.unstableNamespaces",
      "aiChat.suggestedPrompts.podsList.nextActions",
    ],
    "deployments-list": [
      "aiChat.suggestedPrompts.deploymentsList.rolloutIssues",
      "aiChat.suggestedPrompts.deploymentsList.replicaGap",
      "aiChat.suggestedPrompts.deploymentsList.failedReleases",
      "aiChat.suggestedPrompts.deploymentsList.availabilityRisk",
      "aiChat.suggestedPrompts.deploymentsList.topDeployments",
      "aiChat.suggestedPrompts.deploymentsList.nextActions",
    ],
    "nodes-list": [
      "aiChat.suggestedPrompts.nodesList.pressure",
      "aiChat.suggestedPrompts.nodesList.unhealthy",
      "aiChat.suggestedPrompts.nodesList.workloadImpact",
      "aiChat.suggestedPrompts.nodesList.riskTheme",
      "aiChat.suggestedPrompts.nodesList.priorityNodes",
      "aiChat.suggestedPrompts.nodesList.nextActions",
    ],
    "events-list": [
      "aiChat.suggestedPrompts.eventsList.hotEvents",
      "aiChat.suggestedPrompts.eventsList.repeatedFailures",
      "aiChat.suggestedPrompts.eventsList.namespaceBreakdown",
      "aiChat.suggestedPrompts.eventsList.faultPattern",
      "aiChat.suggestedPrompts.eventsList.priorityEvents",
      "aiChat.suggestedPrompts.eventsList.summary",
    ],
    "pod-detail": [
      "aiChat.suggestedPrompts.podDetail.rootCause",
      "aiChat.suggestedPrompts.podDetail.riskCheck",
      "aiChat.suggestedPrompts.podDetail.troubleshoot",
      "aiChat.suggestedPrompts.podDetail.phaseCheck",
      "aiChat.suggestedPrompts.podDetail.resourceConfig",
      "aiChat.suggestedPrompts.podDetail.businessImpact",
    ],
    "deployment-detail": [
      "aiChat.suggestedPrompts.deploymentDetail.releaseCheck",
      "aiChat.suggestedPrompts.deploymentDetail.replicaGap",
      "aiChat.suggestedPrompts.deploymentDetail.recentEvents",
      "aiChat.suggestedPrompts.deploymentDetail.releaseRootCause",
      "aiChat.suggestedPrompts.deploymentDetail.runtimeRisk",
      "aiChat.suggestedPrompts.deploymentDetail.recoveryPlan",
    ],
    "node-detail": [
      "aiChat.suggestedPrompts.nodeDetail.health",
      "aiChat.suggestedPrompts.nodeDetail.workloadRisk",
      "aiChat.suggestedPrompts.nodeDetail.actions",
      "aiChat.suggestedPrompts.nodeDetail.topRisk",
      "aiChat.suggestedPrompts.nodeDetail.impactedWorkloads",
      "aiChat.suggestedPrompts.nodeDetail.maintenanceCheck",
    ],
    "service-detail": [
      "aiChat.suggestedPrompts.serviceDetail.selectorMatch",
      "aiChat.suggestedPrompts.serviceDetail.noEndpoints",
      "aiChat.suggestedPrompts.serviceDetail.portRisk",
      "aiChat.suggestedPrompts.serviceDetail.accessPath",
      "aiChat.suggestedPrompts.serviceDetail.likelyLayer",
      "aiChat.suggestedPrompts.serviceDetail.nextAction",
    ],
    "namespace-detail": [
      "aiChat.suggestedPrompts.namespaceDetail.healthSummary",
      "aiChat.suggestedPrompts.namespaceDetail.abnormalResources",
      "aiChat.suggestedPrompts.namespaceDetail.businessImpact",
      "aiChat.suggestedPrompts.namespaceDetail.priorityOrder",
      "aiChat.suggestedPrompts.namespaceDetail.riskDistribution",
      "aiChat.suggestedPrompts.namespaceDetail.diagnosis",
    ],
    detail: [
      "aiChat.suggestedPrompts.detail.summary",
      "aiChat.suggestedPrompts.detail.anomaly",
      "aiChat.suggestedPrompts.detail.nextSteps",
      "aiChat.suggestedPrompts.detail.riskPoint",
      "aiChat.suggestedPrompts.detail.upstreamImpact",
      "aiChat.suggestedPrompts.detail.checkOrder",
    ],
    list: [
      "aiChat.suggestedPrompts.list.anomalies",
      "aiChat.suggestedPrompts.list.namespaceHotspots",
      "aiChat.suggestedPrompts.list.nextActions",
      "aiChat.suggestedPrompts.list.riskPattern",
      "aiChat.suggestedPrompts.list.priorityObjects",
      "aiChat.suggestedPrompts.list.systemicIssues",
    ],
    default: [
      "aiChat.suggestedPrompts.default.healthCheck",
      "aiChat.suggestedPrompts.default.workloadIssues",
      "aiChat.suggestedPrompts.default.runbook",
      "aiChat.suggestedPrompts.default.riskSummary",
      "aiChat.suggestedPrompts.default.nextCheck",
    ],
  };

  const detailKinds: Record<string, string> = {
    pods: "pod",
    deployments: "deployment",
    nodes: "node",
    services: "service",
    namespaces: "namespace",
  };
  const scene = !page.resource
    ? "overview"
    : page.name
      ? `${detailKinds[page.resource] ?? page.resource}-detail`
      : `${page.resource}-list`;
  const keys = prompts[scene] ?? prompts[page.name ? "detail" : "list"];
  return keys.slice(0, 5).map((key, index) => {
    // Leave resource values to host interpolation; names never become template code.
    const prompt = i18n.t(key, {
      resourceKind: "{{resource.kind}}",
      resourceName: "{{resource.name}}",
      namespace: "{{resource.namespace}}",
      interpolation: { escapeValue: false },
    });
    return {
      id: key.split(".").slice(-2).join("-"),
      label: prompt,
      prompt,
      order: index,
    };
  });
}

export function useDBXRecommendations(page?: DBXPageContext) {
  const { i18n: language } = useTranslation();
  const [contextRevision, setContextRevision] = useState(0);
  useEffect(
    () => bridge()?.onContext?.(() => setContextRevision((value) => value + 1)),
    [],
  );
  const route = page?.route;
  const resource = page?.resource;
  const namespace = page?.namespace;
  const name = page?.name;
  useEffect(() => {
    const page = route ? { route, resource, namespace, name } : undefined;
    const current = bridge();
    if (!current) return;
    let alive = true;
    let connectionId: string | undefined;
    const publishRouteRecommendations = () => {
      if (
        !alive ||
        !page ||
        page.route === "/settings" ||
        connectionId !== current.context?.connectionId ||
        !current.ai?.setRecommendations
      )
        return;
      void current.ai
        .setRecommendations({
          context: recommendationContext(page, current.context?.connectionId),
          items: dbxAIRecommendations(page),
        })
        .catch(() => undefined);
    };
    current.ready
      .then(async () => {
        if (!alive) return;
        connectionId = current.context?.connectionId;
        if (
          !current.capabilities?.aiRecommendations ||
          !current.ai?.setRecommendations
        )
          return;
        await current.ai.setRecommendations({ context: {}, items: [] });
        if (!page || !alive || page.route === "/settings") return;
        const snapshot =
          current.invoke && connectionId
            ? await current.invoke("ai/snapshot", { connectionId, page })
            : undefined;
        if (!alive || connectionId !== current.context?.connectionId) return;
        if (!snapshot || typeof snapshot !== "object") {
          publishRouteRecommendations();
          return;
        }
        await current.ai.setRecommendations({
          context: {
            ...snapshot,
            ...recommendationContext(page, connectionId),
          },
          items: dbxAIRecommendations(page),
        });
      })
      .catch(() => {
        // Keep useful route-specific chips when the optional snapshot is unavailable.
        if (
          alive &&
          current.capabilities?.aiRecommendations &&
          current.ai?.setRecommendations &&
          page
        ) {
          publishRouteRecommendations();
        }
      });
    return () => {
      alive = false;
    };
  }, [route, resource, namespace, name, language.language, contextRevision]);
}
