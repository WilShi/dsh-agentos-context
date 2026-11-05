/** Settings data face: DSH credentials + authenticated Connection RPC. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'

export interface CredentialInfo { configured: boolean; writable: boolean }
export type VerifyKeyCode = 'OK' | 'KEY_MISSING' | 'KEY_INVALID' | 'NO_PERMISSION' | 'UPSTREAM' | 'NETWORK'
export interface VerifyKeyResult { ok: boolean; code: VerifyKeyCode; hint?: string; applyUrl?: string; dimensions?: number }
export interface ModelsResult {
  keyConfigured: boolean
  models: string[]
  auto: string | null
  configured: string | null
  apiKeyEnv?: string
  embeddingBaseUrl?: string
  error?: string
  hint?: string
  applyUrl?: string
}
export interface OcApi {
  describeCredential(ref: string): Promise<CredentialInfo>
  setCredential(ref: string, value: string): Promise<void>
  verifyKey(req: { apiKey: string }): Promise<VerifyKeyResult>
  listModels(): Promise<ModelsResult>
}
export function createOcApi(api:Pick<ClientRemote,'credentials'>,rpc:ClientConnectionRpc):OcApi{
  async function call<T>(method:string,payload:Record<string,unknown>):Promise<T>{const result=await rpc.call('/api','agentos-context/v1/'+method,payload);if(!result.ok)throw new Error(result.error.message);return result.value as T}
  return{ async describeCredential(ref){const response=await api.credentials.describe([ref]);if(!response.ok)throw new Error(response.error.message);const view=response.value[ref];return{ configured:view?.configured??false,writable:view?.writable??true }},async setCredential(ref,value){const response=await api.credentials.set(ref,value);if(!response.ok)throw new Error(response.error.message)},verifyKey:req=>call<VerifyKeyResult>('verify-key',req),listModels:()=>call<ModelsResult>('models',{}) }
}
