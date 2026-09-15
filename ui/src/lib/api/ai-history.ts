import { apiClient } from '../api-client'

export interface AIChatPageContextPayload {
  page: string
  namespace: string
  resourceName: string
  resourceKind: string
}

export interface AIChatMessagePayload {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  toolCallId?: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  inputRequest?: Record<string, unknown>
  pendingAction?: Record<string, unknown>
  actionStatus?: 'pending' | 'confirmed' | 'denied' | 'error'
}

export interface AIChatSessionSummaryPayload {
  sessionId: string
  title: string
  clusterName?: string
  pageContext: AIChatPageContextPayload
  messageCount: number
  createdAt: string
  updatedAt: string
  lastMessageAt: string
}

export interface AIChatSessionDetailPayload extends AIChatSessionSummaryPayload {
  messages: AIChatMessagePayload[]
}

export interface AIChatSessionListPayload {
  data: AIChatSessionSummaryPayload[]
  total: number
  page: number
  pageSize: number
}

export interface UpsertAIChatSessionPayload {
  title: string
  pageContext: AIChatPageContextPayload
  messages: AIChatMessagePayload[]
}

export async function listChatSessions(page = 1, pageSize = 50) {
  return apiClient.get<AIChatSessionListPayload>(
    `/ai/sessions?page=${page}&pageSize=${pageSize}`
  )
}

export async function getChatSession(sessionId: string) {
  return apiClient.get<AIChatSessionDetailPayload>(`/ai/sessions/${sessionId}`)
}

export async function upsertChatSession(
  sessionId: string,
  payload: UpsertAIChatSessionPayload
) {
  return apiClient.put<AIChatSessionSummaryPayload>(
    `/ai/sessions/${sessionId}`,
    payload
  )
}

export async function deleteChatSession(sessionId: string) {
  return apiClient.delete<string>(`/ai/sessions/${sessionId}`)
}
