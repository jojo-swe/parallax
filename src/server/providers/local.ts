import { argoConfig } from "./argolink";
import { comfyConfig, isLocalEndpoint } from "./comfyui";

/** Null when the backend behind a local endpoint is set up, else what the operator must set. */
export function localSetupHint(endpoint: string, env: Record<string, string | undefined> = process.env): string | null {
  if (!isLocalEndpoint(endpoint)) return null;
  if (endpoint.startsWith("argolink.")) return argoConfig(env) ? null : "Set ARGOLINK_API_KEY.";
  return comfyConfig(env) ? null : "Set COMFYUI_BASE_URL.";
}
